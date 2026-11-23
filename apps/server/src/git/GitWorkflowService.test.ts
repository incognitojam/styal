import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "../nodeServices.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { layerMemory } from "../persistence/Sqlite.ts";
import * as WorkspacePortAllocator from "../workspace/WorkspacePortAllocator.ts";
import { fixture } from "../worktreeCleanup/fixtures.testkit.ts";
import { makeCheckout } from "../worktreeCleanup/Checkout.ts";

function layer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
    Layer.provide(Layer.mock(WorkspacePortAllocator.WorkspacePortAllocator)({})),
  );
}

const realGitLayer = (
  baseDirOrPrefix: string | { readonly prefix: string },
  worktreesDirectory?: string,
) =>
  GitWorkflowService.layer.pipe(
    Layer.provide(VcsDriverRegistry.layer),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
    Layer.provideMerge(WorkspacePortAllocator.layer),
    Layer.provideMerge(layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provide(ServerSettings.layerTest(worktreesDirectory ? { worktreesDirectory } : {})),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), baseDirOrPrefix).pipe(
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const managedGitFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "t3-git-worktree-boundary-" }),
  );
  const enclosing = `${base}/enclosing`;
  const managed = `${enclosing}/managed`;
  const context = yield* Layer.build(realGitLayer(base, managed));
  const git = Context.get(context, GitVcsDriver.GitVcsDriver);
  const workflow = Context.get(context, GitWorkflowService.GitWorkflowService);
  const sql = Context.get(context, SqlClient.SqlClient);
  const command = (cwd: string, args: ReadonlyArray<string>) =>
    git.execute({ operation: "fixture", cwd, args }).pipe(Effect.map(({ stdout }) => stdout));
  const init = Effect.fn("fixture.initRepository")(function* (
    cwd: string,
    options: ReadonlyArray<string> = [],
  ) {
    yield* fs.makeDirectory(cwd, { recursive: true });
    yield* command(cwd, ["init", "-b", "main", ...options]);
    yield* fs.writeFileString(`${cwd}/source.txt`, "tracked source\n");
    yield* command(cwd, ["add", "source.txt"]);
    yield* command(cwd, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture: source",
    ]);
  });
  yield* init(enclosing);
  yield* fs.makeDirectory(managed);
  const record = (worktreePath: string) => sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, payload_json
    ) VALUES (
      ${worktreePath}, 'fixture', 'Fixture', 'codex', 'full-access', 'default',
      '1970-01-01', '1970-01-01', ${JSON.stringify({ worktreePath })}
    )
  `;
  return { fs, path, base, enclosing, managed, workflow, command, init, record };
}).pipe(Effect.provide(NodeServices.layer));

const layerTest = Layer.merge(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-workflow-" }),
  ServerSettings.layerTest(),
).pipe(
  Layer.provideMerge(layerMemory),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.layer(layerTest)("GitWorkflowService", (it) => {
  it.effect.each([{ location: "root" }, { location: "nested" }, { location: "missing-nested" }])(
    "restores source before committing from $location",
    ({ location }) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write("src/main.txt", "tracked source");
        yield* f.command(f.worktree, ["add", "src/main.txt"]);
        yield* f.command(f.worktree, ["commit", "-m", "fixture: source"]);
        yield* f.write("notes.txt", "untracked change");
        if (location === "nested") yield* f.write("src/keep.txt", "untracked note");
        const checkout = yield* makeCheckout.pipe(
          Effect.provideService(GitVcsDriver.GitVcsDriver, f.git),
        );
        yield* checkout.release(f.worktree, f.root);
        assert.isFalse(yield* f.fs.exists(`${f.worktree}/src/main.txt`));
        const workflow = yield* GitWorkflowService.make.pipe(
          Effect.provideService(ServerConfig.ServerConfig, f.config),
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(GitVcsDriver.GitVcsDriver, f.git),
              Layer.mock(WorkspacePortAllocator.WorkspacePortAllocator)({}),
              Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
                resolve: ({ cwd }) =>
                  f.command(cwd, ["rev-parse", "--show-toplevel"]).pipe(
                    Effect.orDie,
                    Effect.map(
                      (result) =>
                        ({
                          kind: "git",
                          repository: { rootPath: result.stdout.trim() },
                        }) as VcsDriverRegistry.VcsDriverHandle,
                    ),
                  ),
              }),
              Layer.mock(GitManager.GitManager)({
                runStackedAction: () =>
                  Effect.gen(function* () {
                    assert.equal(
                      yield* f.fs.readFileString(`${f.worktree}/src/main.txt`).pipe(Effect.orDie),
                      "tracked source",
                    );
                    yield* f.command(f.worktree, ["add", "notes.txt"]);
                    yield* f.command(f.worktree, ["commit", "-m", "fixture: note"]);
                    return {} as never;
                  }),
              }),
            ),
          ),
        );
        yield* workflow.runStackedAction({
          actionId: "fixture",
          cwd: location === "root" ? f.worktree : `${f.worktree}/src`,
          action: "commit",
          commitMessage: "fixture: note",
        });
        const committed = yield* f.command(f.worktree, ["show", "HEAD:notes.txt"]);
        assert.equal(committed.stdout.trim(), "untracked change");
      }).pipe(Effect.scoped),
  );

  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasHeadCommit: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasHeadCommit: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "t3/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
    }).pipe(Effect.scoped, Effect.provide(realGitLayer({ prefix: "t3-ref-named-" }))),
  );

  it.effect("removing a worktree frees its port range", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const ports = yield* WorkspacePortAllocator.WorkspacePortAllocator;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-remove-port-" });
      const worktreePath = path.join(cwd, "worktrees", "feature");
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["worktree", "add", "-b", "feature", worktreePath],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      yield* ports.getBasePort(cwd);
      yield* ports.getBasePort(worktreePath);

      yield* workflow.removeWorktree({ cwd, path: "worktrees/feature", force: true });

      const reserved = yield* sql<{ readonly workspacePath: string }>`
        SELECT workspace_path AS "workspacePath" FROM workspace_port_allocations
      `;
      assert.deepStrictEqual(
        reserved.map(({ workspacePath }) => workspacePath),
        [path.resolve(cwd)],
      );
      assert.isFalse(yield* fileSystem.exists(worktreePath));
    }).pipe(Effect.scoped, Effect.provide(realGitLayer({ prefix: "t3-remove-port-" }))),
  );
});

it.live.each([
  { label: "an ordinary repository below the managed folder", rootPath: "project" },
  { label: "a deeply nested repository", rootPath: "group/project/repository" },
  { label: "an in-folder symlink", rootPath: "project", alias: "alias" },
  { label: "a linked worktree", rootPath: "project/topic", linked: true },
  { label: "a separate Git directory", rootPath: "project/topic", separate: true },
  { label: "a repository inside a linked worktree", rootPath: "project/topic/inner", nested: true },
  { label: "the enclosing repository from outside the managed folder", rootPath: null },
])("uses $label", ({ rootPath, alias, linked, separate, nested }) =>
  Effect.gen(function* () {
    if (alias && (yield* HostProcess.Platform) === "win32") return;
    const f = yield* managedGitFixture;
    const root = rootPath === null ? f.enclosing : `${f.managed}/${rootPath}`;
    if (linked || nested) {
      yield* f.command(f.enclosing, [
        "worktree",
        "add",
        "-b",
        "topic",
        `${f.managed}/project/topic`,
      ]);
    }
    if (rootPath !== null && !linked) {
      yield* f.init(root, separate ? ["--separate-git-dir", `${f.base}/git-metadata`] : []);
    }
    yield* f.fs.makeDirectory(`${root}/topic`);
    const entry = alias ? `${f.managed}/${alias}` : root;
    if (alias) yield* f.fs.symlink(root, entry);
    if (rootPath !== null) yield* f.record(nested ? `${f.managed}/project/topic` : entry);

    for (const cwd of alias ? [entry, `${entry}/topic`] : [`${entry}/topic`]) {
      assert.strictEqual(yield* f.workflow.repositoryRoot(cwd), root);
      assert.strictEqual(yield* f.workflow.currentBranch(cwd), linked ? "topic" : "main");
    }
    const refName = "fixture-branch";
    yield* f.workflow.createRef({ cwd: `${entry}/topic`, refName, switchRef: true });
    assert.strictEqual(
      (yield* f.command(root, ["symbolic-ref", "HEAD"])).trim(),
      `refs/heads/${refName}`,
    );
  }),
);

it.live.each([
  { label: "a symlink", parentTraversal: false },
  { label: "a symlink followed by '..'", parentTraversal: true },
])("refuses $label that leads outside the managed folder", ({ parentTraversal }) =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const f = yield* managedGitFixture;
    const project = `${f.managed}/project`;
    yield* f.init(project);
    const alias = `${project}/escape`;
    const target = parentTraversal ? `${f.enclosing}/outside` : f.enclosing;
    if (parentTraversal) yield* f.fs.makeDirectory(target);
    yield* f.fs.symlink(target, alias);
    const cwd = parentTraversal ? `${alias}/..` : alias;
    assert.strictEqual(
      (yield* f.command(f.enclosing, ["-C", cwd, "rev-parse", "--show-toplevel"])).trim(),
      f.enclosing,
    );

    assert.deepStrictEqual(
      yield* Effect.all({
        root: f.workflow.repositoryRoot(cwd),
        branch: f.workflow.currentBranch(cwd),
        creation: f.workflow.createRef({ cwd, refName: "escaped" }).pipe(
          Effect.result,
          Effect.map(({ _tag }) => _tag),
        ),
      }),
      { root: null, branch: null, creation: "Failure" },
    );
  }),
);

it.live.each([
  { layout: "outside" },
  { layout: "project/topic" },
  { layout: "outer/inner" },
  { layout: "managed-root" },
  { layout: "project/topic", relative: true },
])(
  "refuses a recorded worktree after it loses its gitfile: $layout (relative: $relative)",
  ({ layout, relative = false }) =>
    Effect.gen(function* () {
      const f = yield* managedGitFixture;
      const enclosing =
        layout === "outside"
          ? f.enclosing
          : layout === "managed-root"
            ? f.managed
            : `${f.managed}/${layout.split("/")[0]}`;
      if (layout !== "outside") yield* f.init(enclosing);
      const worktree =
        layout === "managed-root"
          ? `${f.managed}/topic`
          : `${f.managed}/${layout === "outer/inner" ? layout : "project/topic"}`;
      const cwd = `${worktree}/src`;
      const note = `${cwd}/untracked.txt`;
      yield* f.command(f.enclosing, ["worktree", "add", "-b", "topic", worktree]);
      yield* f.fs.makeDirectory(cwd);
      yield* f.fs.writeFileString(note, "untracked work\n");
      yield* f.record(relative ? f.path.relative(process.cwd(), worktree) : worktree);
      assert.strictEqual(yield* f.workflow.repositoryRoot(cwd), worktree);
      assert.strictEqual(yield* f.workflow.currentBranch(cwd), "topic");

      const enclosingState = Effect.forEach(
        [
          ["symbolic-ref", "HEAD"],
          ["rev-parse", "HEAD"],
          ["ls-files", "--stage", "-z"],
          ["for-each-ref", "--format=%(refname) %(objectname)"],
        ],
        (args) => f.command(enclosing, args),
      );
      const before = yield* enclosingState;
      yield* f.fs.remove(`${worktree}/.git`);
      assert.strictEqual(
        (yield* f.command(cwd, ["rev-parse", "--show-toplevel"])).trim(),
        enclosing,
      );

      assert.deepStrictEqual(
        yield* Effect.all({
          root: f.workflow.repositoryRoot(cwd),
          branch: f.workflow.currentBranch(cwd),
          creation: f.workflow.createRef({ cwd, refName: "wrong-repository" }).pipe(
            Effect.result,
            Effect.map(({ _tag }) => _tag),
          ),
          enclosingState,
          note: f.fs.readFileString(note),
        }),
        {
          root: null,
          branch: null,
          creation: "Failure",
          enclosingState: before,
          note: "untracked work\n",
        },
      );
    }),
);
