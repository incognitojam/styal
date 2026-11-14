import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import {
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectConfigLoader from "../project/ProjectConfigLoader.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Approvals from "./Approvals.ts";
import * as WorktreeCleanup from "./WorktreeCleanup.ts";
import { makeSelect } from "./Selection.ts";

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(0),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}
const dependencies = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "cleanup-preview-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const root = yield* fs.makeTempDirectoryScoped({
    directory: `${process.cwd()}/.scratch`,
    prefix: "cleanup-preview-",
  });
  const command = (cwd: string, args: readonly string[]) =>
    git.execute({ operation: "test", cwd, args });
  yield* command(root, ["init"]);
  yield* command(root, ["config", "user.name", "Fixture"]);
  yield* command(root, ["config", "user.email", "fixture@example.invalid"]);
  yield* fs.writeFileString(
    `${root}/.gitignore`,
    "**/dist/\n**/node_modules/\n*.tsbuildinfo\n.turbo/\nnotes/\nlinked/\nnested/\n",
  );
  yield* command(root, ["add", "."]);
  yield* command(root, ["commit", "-m", "fixture"]);
  const worktree = `${config.worktreesDir}/fixture/settled`;
  yield* fs.makeDirectory(`${config.worktreesDir}/fixture`, { recursive: true });
  yield* command(root, ["worktree", "add", "--detach", worktree]);
  const write = (relative: string, text = "synthetic payload") =>
    Effect.gen(function* () {
      const parent = relative.slice(0, relative.lastIndexOf("/"));
      if (relative.includes("/"))
        yield* fs.makeDirectory(`${worktree}/${parent}`, { recursive: true });
      yield* fs.writeFileString(`${worktree}/${relative}`, text);
    });
  return { fs, root, worktree, command, write, config };
});

describe("WorktreeCleanup", () => {
  it.effect(
    "selects ignored outputs whole and keeps work, links and nested checkouts without changing files",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const name of [
          "node_modules/pkg/index.js",
          "apps/web/node_modules/pkg/file",
          ".turbo/cache",
          "cache.tsbuildinfo",
          "dist/untracked",
          "notes/ignored",
          "source/untracked",
          "tracked/dist/source",
        ])
          yield* f.write(name);
        yield* f.command(f.worktree, ["add", "-f", "tracked/dist/source"]);
        yield* f.fs.symlink(f.root, `${f.worktree}/linked`);
        yield* f.fs.makeDirectory(`${f.worktree}/nested`);
        yield* f.command(`${f.worktree}/nested`, ["init"]);
        yield* f.write("nested/dist/output");
        yield* f.write("unsafe/dist/keep");
        yield* f.fs.symlink(f.root, `${f.worktree}/unsafe/dist/outside`);
        const select = yield* makeSelect;
        const result = yield* select(f.worktree, [
          "**/node_modules",
          "**/dist",
          ".turbo",
          "*.tsbuildinfo",
          "source/untracked",
          "linked",
          "nested",
          ".git",
        ]);
        assert.deepEqual(result.selected.map((entry) => entry.path).sort(), [
          ".turbo",
          "apps/web/node_modules",
          "cache.tsbuildinfo",
          "dist",
          "node_modules",
        ]);
        assert.deepEqual(
          Object.fromEntries(result.kept.map((entry) => [entry.path, entry.reason])),
          {
            linked: "symbolic-link",
            nested: "nested-checkout",
            "source/untracked": "not-ignored",
            "tracked/dist": "contains-tracked-files",
            "unsafe/dist": "symbolic-link",
          },
        );
        assert.isAbove(result.freedBytes!, 0);
        assert.isFalse(result.truncated);
        assert.equal(
          yield* f.fs.readFileString(`${f.worktree}/node_modules/pkg/index.js`),
          "synthetic payload",
        );
      }).pipe(Effect.provide(dependencies), Effect.scoped),
  );

  it.effect("keeps same-device bind mounts and cross-device candidates", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write("dist/output");
      const originalStat = f.fs.stat;
      for (const mode of ["bind", "device"] as const) {
        const select = yield* makeSelect.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            readFileString: (file, options) =>
              file === "/proc/self/mountinfo"
                ? Effect.succeed(
                    mode === "bind" ? `1 0 0:1 / ${f.worktree}/dist rw - tmpfs tmpfs rw` : "",
                  )
                : f.fs.readFileString(file, options),
            stat: (file) =>
              originalStat(file).pipe(
                Effect.map((info) =>
                  mode === "device" && file === `${f.worktree}/dist`
                    ? { ...info, dev: info.dev + 1n }
                    : info,
                ),
              ),
          }),
        );
        const result = yield* select(f.worktree, ["dist"]);
        assert.equal(result.selected.length, 0);
        assert.equal(result.kept[0]?.reason, "mount-point");
      }
    }).pipe(Effect.provide(dependencies), Effect.scoped),
  );

  it.effect(
    "reviews exact lists, revokes changed approvals, and previews settled, empty and unsettled worktrees with honest hardlink bytes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const empty = `${f.config.worktreesDir}/fixture/empty`;
        const busy = `${f.config.worktreesDir}/fixture/busy`;
        const missing = `${f.config.worktreesDir}/fixture/missing`;
        const linked = `${f.config.worktreesDir}/fixture/linked`;
        const plain = `${f.config.worktreesDir}/fixture/plain`;
        yield* f.fs.symlink(f.worktree, linked);
        yield* f.fs.makeDirectory(plain);
        for (const target of [empty, busy])
          yield* f.command(f.root, ["worktree", "add", "--detach", target]);
        yield* f.write("dist/output", "x".repeat(8192));
        yield* f.write("dist/shared", "y".repeat(8192));
        yield* f.fs.link(`${f.worktree}/dist/shared`, `${f.root}/shared`);
        yield* f.fs.makeDirectory(`${busy}/dist`);
        yield* f.fs.writeFileString(`${busy}/dist/output`, "synthetic");
        const project = {
          id: ProjectId.make("project-1"),
          title: "Fixture",
          workspaceRoot: f.root,
          repositoryIdentity: null,
          faviconPath: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          deletedAt: null,
        };
        const threads = [
          shell({ worktreePath: f.worktree, settledOverride: "settled" }),
          shell({ id: ThreadId.make("empty"), worktreePath: empty, settledOverride: "settled" }),
          shell({ id: ThreadId.make("busy"), worktreePath: busy }),
          shell({ id: ThreadId.make("main"), worktreePath: f.root }),
          shell({ id: ThreadId.make("missing"), worktreePath: missing }),
          shell({ id: ThreadId.make("linked"), worktreePath: linked }),
          shell({ id: ThreadId.make("plain"), worktreePath: plain }),
        ];
        const external = Layer.mergeAll(
          Settings.layerTest(),
          ProjectConfigLoader.layer,
          Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedSome(project) }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: threads.slice(0, 2),
                archivedThreads: threads.slice(2),
                projects: [],
              }),
          }),
        );
        const service = WorktreeCleanup.layer.pipe(
          Layer.provideMerge(Approvals.layer),
          Layer.provideMerge(external),
        );
        yield* Effect.gen(function* () {
          const approvals = yield* Approvals.Approvals;
          const cleanup = yield* WorktreeCleanup.WorktreeCleanup;
          const input = { projectId: project.id };
          assert.equal((yield* approvals.review(input)).status, "none");
          yield* f.fs.writeFileString(
            `${f.root}/styal.json`,
            JSON.stringify({ worktreeCleanup: ["dist"] }),
          );
          assert.equal((yield* approvals.review(input)).status, "unapproved");
          assert.deepEqual((yield* cleanup.preview({ ...input, list: "approved" })).patterns, []);
          assert.equal(
            (yield* approvals.setApproved({ ...input, approved: true })).status,
            "approved",
          );
          const preview = yield* cleanup.preview({ ...input, list: "approved" });
          assert.equal(
            preview.worktrees.find((entry) => entry.worktreePath === empty)?.freedBytes,
            0,
          );
          assert.equal(
            preview.worktrees.find((entry) => entry.worktreePath === busy)?.reason,
            "unsettled-thread",
          );
          assert.isAbove(
            preview.worktrees.find((entry) => entry.worktreePath === busy)!.selected.length,
            0,
          );
          assert.equal(
            preview.worktrees.find((entry) => entry.worktreePath === f.root)?.reason,
            "not-managed-worktree",
          );
          for (const [target, reason] of [
            [missing, "missing"],
            [linked, "symbolic-link"],
            [plain, "not-managed-worktree"],
          ] as const) {
            assert.equal(
              preview.worktrees.find((entry) => entry.worktreePath === target)?.reason,
              reason,
            );
          }
          const stat = yield* f.fs.stat(`${f.worktree}/dist/output`);
          const expected = Option.match(stat.blocks, {
            onSome: (blocks) => Number(blocks * 512n),
            onNone: () => Number(stat.size),
          });
          assert.equal(
            preview.worktrees.find((entry) => entry.worktreePath === f.worktree)?.freedBytes,
            expected,
          );
          yield* f.fs.writeFileString(
            `${f.root}/styal.json`,
            JSON.stringify({ worktreeCleanup: ["dist", "node_modules"] }),
          );
          const changed = yield* approvals.review(input);
          assert.equal(changed.status, "changed");
          assert.deepEqual(changed.previouslyApprovedPatterns, ["dist"]);
          assert.deepEqual((yield* cleanup.preview({ ...input, list: "approved" })).patterns, []);
          assert.deepEqual((yield* cleanup.preview({ ...input, list: "declared" })).patterns, [
            "dist",
            "node_modules",
          ]);
          assert.equal(
            (yield* approvals.setApproved({ ...input, approved: false })).status,
            "unapproved",
          );
        }).pipe(Effect.provide(service));
      }).pipe(Effect.provide(dependencies), Effect.scoped),
  );
});
