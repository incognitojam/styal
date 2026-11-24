import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "../nodeServices.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
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

const realGitLayer = (prefix: string) =>
  GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
      }),
    ),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
    Layer.provideMerge(WorkspacePortAllocator.layer),
    Layer.provideMerge(layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix }).pipe(
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("GitWorkflowService", (it) => {
  it.effect.each([
    "released",
    "recovery-required",
    "user-sparse",
    "obstructed",
    "missing-nested",
  ] as const)("reports source checkout state and checks out again: %s", (state) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.command(f.worktree, ["switch", "-c", "fixture-state"]);
      yield* f.write("src/source", "source");
      yield* f.command(f.worktree, ["add", "."]);
      yield* f.command(f.worktree, ["commit", "-m", "fixture: source"]);
      yield* f.write(".scratch/note", "keep");
      const checkout = yield* makeCheckout.pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, f.git),
      );
      if (state === "user-sparse")
        yield* f.command(f.worktree, ["sparse-checkout", "set", "--no-cone", "/*", "!/*/"]);
      else yield* checkout.release(f.worktree, f.root);
      if (state === "recovery-required") {
        const admin = (yield* f.command(f.worktree, [
          "rev-parse",
          "--absolute-git-dir",
        ])).stdout.trim();
        const journal = `${admin}/styal-checkout.json`;
        yield* f.fs.writeFileString(
          journal,
          (yield* f.fs.readFileString(journal)).replace('"released"', '"releasing"'),
        );
      }
      const workflow = yield* GitWorkflowService.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(GitVcsDriver.GitVcsDriver, f.git),
            Layer.mock(WorkspacePortAllocator.WorkspacePortAllocator)({}),
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              detect: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
            }),
            Layer.mock(GitManager.GitManager)({
              localStatus: (input) => f.git.status(input),
              invalidateStatus: () => Effect.void,
            }),
          ),
        ),
      );
      const cwd = state === "missing-nested" ? `${f.worktree}/src` : f.worktree;
      assert.equal(yield* workflow.currentBranch(cwd), "fixture-state");
      assert.equal(yield* workflow.headPath(cwd), yield* workflow.headPath(f.worktree));
      assert.isTrue((yield* workflow.localStatus({ cwd })).isRepo);
      assert.equal(
        (yield* workflow.localStatus({ cwd })).sourceCheckout,
        state === "user-sparse"
          ? undefined
          : state === "obstructed" || state === "missing-nested"
            ? "released"
            : state,
      );
      if (state === "obstructed") {
        yield* f.write("src", "keep obstruction");
        const failure = yield* workflow.checkOutSources({ cwd: f.worktree }).pipe(Effect.flip);
        assert.equal(failure._tag, "WorktreeCleanupError");
        assert.include(failure.message, '"src"');
        assert.equal(yield* f.fs.readFileString(`${f.worktree}/src`), "keep obstruction");
        yield* f.fs.remove(`${f.worktree}/src`);
      }
      yield* workflow.checkOutSources({ cwd: `${f.worktree}/src` });
      assert.equal(yield* f.fs.exists(`${f.worktree}/src/source`), state !== "user-sparse");
      assert.equal(yield* f.fs.readFileString(`${f.worktree}/.scratch/note`), "keep");
      assert.isUndefined((yield* workflow.localStatus({ cwd: f.worktree })).sourceCheckout);
    }).pipe(Effect.scoped),
  );
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
    }).pipe(Effect.scoped, Effect.provide(realGitLayer("t3-ref-named-"))),
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
    }).pipe(Effect.scoped, Effect.provide(realGitLayer("t3-remove-port-"))),
  );
});
