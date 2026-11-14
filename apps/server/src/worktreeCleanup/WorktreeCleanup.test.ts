import { ChildProcessSpawner } from "effect/process";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as StorageCleanup from "../storageCleanup.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Stream from "effect/Stream";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as GitManager from "../git/GitManager.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { ServerActivation } from "../serverActivation.ts";
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
import { makeSelect, SelectionLimits } from "./Selection.ts";
import { TestClock } from "effect/testing";

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
const measurementLayer = StorageCleanup.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Settings.layerTest(),
      Layer.mock(ProjectStore.ProjectStoreV2)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
      Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty }),
      NodeSqliteClient.layer({ filename: ":memory:" }),
      Layer.mock(GitManager.GitManager)({}),
      Layer.mock(TerminalManager.TerminalManager)({
        subscribeMetadata: () => Effect.succeed(() => {}),
      }),
      Layer.succeed(ServerActivation, Effect.never),
    ),
  ),
);
const dependencies = measurementLayer.pipe(
  Layer.provideMerge(
    GitVcsDriver.layer.pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "cleanup-preview-" })),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  ),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const git = yield* GitVcsDriver.GitVcsDriver;
  yield* fs.makeDirectory(`${process.cwd()}/.scratch`, { recursive: true });
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
    "reports approved descendant patterns inside a pending selected parent without double counting",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write("dist/sub/output");
        yield* f.write("dist/other");
        const storage = yield* StorageCleanup.StorageCleanup;
        const select = yield* makeSelect.pipe(
          Effect.provideService(StorageCleanup.StorageCleanup, {
            ...storage,
            measureWorktree: (_root, target) =>
              Effect.succeed(target?.endsWith("/sub") ? 512 : 1024),
          }),
        );
        const result = yield* select(
          f.worktree,
          ["dist", "dist/sub"],
          ["dist", "dist/sub"],
          new Set(["dist/sub"]),
        );
        assert.deepEqual(
          result.selected.map(({ path, patterns, patternStatus, freedBytes, insideSelected }) => ({
            path,
            patterns,
            patternStatus,
            freedBytes,
            insideSelected,
          })),
          [
            {
              path: "dist",
              patterns: ["dist"],
              patternStatus: "pending",
              freedBytes: 1024,
              insideSelected: null,
            },
            {
              path: "dist/sub",
              patterns: ["dist/sub"],
              patternStatus: "approved",
              freedBytes: 512,
              insideSelected: "dist",
            },
          ],
        );
        assert.equal(result.freedBytes, 1024);
        const approvedOnly = yield* select(
          f.worktree,
          ["dist/sub"],
          ["dist", "dist/sub"],
          new Set(["dist/sub"]),
        );
        assert.equal(approvedOnly.freedBytes, 512);
        assert.equal(approvedOnly.selected[0]?.insideSelected, null);
      }).pipe(Effect.provide(dependencies), Effect.scoped),
  );

  it.effect(
    "uses one preview deadline including git probes and marks later worktrees not checked",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write("dist/output");
        yield* f.command(f.root, ["worktree", "add", "--detach", `${f.worktree}-later`]);
        const completed = yield* Deferred.make<void>();
        const measuring = yield* Deferred.make<void>();
        const finishMeasurement = yield* Deferred.make<void>();
        const storage = yield* StorageCleanup.StorageCleanup;
        const entered = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        const git = yield* GitVcsDriver.GitVcsDriver;
        let probes = 0;
        const projectId = ProjectId.make("project-1");
        const external = Layer.mergeAll(
          Settings.layerTest(),
          Layer.mock(Approvals.Approvals)({
            review: () =>
              Effect.succeed({
                status: "approved",
                declared: [{ pattern: "dist", status: "approved" }],
                approvedNotDeclared: [],
              }),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeedSome({
                id: projectId,
                workspaceRoot: f.root,
                title: "Fixture",
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                deletedAt: null,
              }),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: [
                  shell({ worktreePath: f.worktree, settledOverride: "settled" }),
                  shell({ id: ThreadId.make("later"), worktreePath: `${f.worktree}-later` }),
                  shell({
                    id: ThreadId.make("unreached"),
                    worktreePath: `${f.worktree}-unreached`,
                  }),
                ],
                archivedThreads: [],
              }),
          }),
        );
        const program = Effect.gen(function* () {
          const cleanup = yield* WorktreeCleanup.WorktreeCleanup;
          const running = yield* cleanup
            .preview({ projectId, list: "declared" })
            .pipe(Effect.ensuring(Deferred.succeed(completed, undefined)), Effect.forkChild);
          yield* Deferred.await(measuring);
          yield* TestClock.adjust("20 seconds");
          yield* Deferred.succeed(finishMeasurement, undefined);
          yield* Deferred.await(entered);
          yield* TestClock.adjust("10 seconds");
          assert.isTrue(yield* Deferred.isDone(completed));
          const result = yield* Fiber.join(running);
          yield* Deferred.await(stopped);
          assert.isTrue(result.deadlineReached);
          assert.equal(probes, 1);
          assert.equal(result.worktrees.length, 3);
          assert.isTrue(result.worktrees[0]!.measurementComplete);
          assert.equal(result.worktrees[0]!.freedBytes, 512);
          for (const entry of result.worktrees.slice(1)) {
            assert.equal(entry.reason, "not-checked");
            assert.equal(entry.status, "kept");
            assert.isTrue(entry.entriesTruncated);
            assert.isFalse(entry.measurementComplete);
          }
        });
        yield* program.pipe(
          Effect.provide(WorktreeCleanup.layer.pipe(Layer.provide(external))),
          Effect.provideService(StorageCleanup.StorageCleanup, {
            ...storage,
            measureWorktree: () =>
              Deferred.succeed(measuring, undefined).pipe(
                Effect.andThen(Deferred.await(finishMeasurement)),
                Effect.as(512),
              ),
          }),
          Effect.provideService(GitVcsDriver.GitVcsDriver, {
            ...git,
            execute: (input) => {
              if (input.cwd !== `${f.worktree}-later`) return git.execute(input);
              probes++;
              return Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
              );
            },
          }),
        );
      }).pipe(Effect.provide(dependencies), Effect.scoped),
  );

  it.effect("interrupting inspection kills its git child and stops an in-progress walk", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawned = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const git = yield* GitVcsDriver.make.pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            spawner.spawn(command).pipe(Effect.tap((handle) => Deferred.succeed(spawned, handle))),
          ),
        ),
      );
      const select = yield* makeSelect.pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, {
          ...git,
          execute: (input) => git.execute({ ...input, args: ["hash-object", "--stdin"] }),
        }),
      );
      const running = yield* select(f.worktree, ["dist"]).pipe(Effect.forkChild);
      const child = yield* Deferred.await(spawned);
      yield* Fiber.interrupt(running);
      assert.isFalse(yield* child.isRunning);
      yield* f.write("dist/output");
      const entered = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const walking = yield* makeSelect.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          readDirectory: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
            ),
        }),
      );
      const walk = yield* walking(f.worktree, ["dist"]).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(walk);
      yield* Deferred.await(stopped);
    }).pipe(Effect.provide(dependencies), Effect.scoped),
  );

  it.effect("reports an incomplete walk even when it stops before reaching a candidate", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write("dist/output");
      const select = yield* makeSelect.pipe(
        Effect.provideService(SelectionLimits, {
          verificationEntries: 100,
          traversalEntries: 1,
          reportEntries: 100,
        }),
      );
      const result = yield* select(f.worktree, ["dist"]);
      assert.isTrue(result.entriesTruncated);
      assert.isFalse(result.measurementComplete);
      assert.isNull(result.freedBytes);
      assert.deepEqual(result.selected, []);
    }).pipe(Effect.provide(dependencies), Effect.scoped),
  );

  it.effect("ignores an inherited index when protecting tracked files inside ignored output", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write("dist/tracked", "source");
      yield* f.command(f.worktree, ["add", "-f", "dist/tracked"]);
      const select = yield* makeSelect;
      const previous = process.env.GIT_INDEX_FILE;
      process.env.GIT_INDEX_FILE = `${f.root}/nonexistent-index`;
      try {
        const result = yield* select(f.worktree, ["dist"]);
        assert.equal(result.selected.length, 0);
        assert.equal(result.kept[0]?.reason, "contains-tracked-files");
      } finally {
        if (previous === undefined) delete process.env.GIT_INDEX_FILE;
        else process.env.GIT_INDEX_FILE = previous;
      }
    }).pipe(Effect.provide(dependencies), Effect.scoped),
  );

  it.effect("keeps a bare repository at any depth of a matched directory", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write("dist/deep/placeholder");
      yield* f.command(`${f.worktree}/dist/deep`, ["init", "--bare", "archive.git"]);
      const select = yield* makeSelect;
      const result = yield* select(f.worktree, ["dist"]);
      assert.equal(result.selected.length, 0);
      assert.equal(result.kept[0]?.reason, "nested-checkout");
      assert.equal(result.kept[0]?.detail, "dist/deep/archive.git");
      yield* f.write("node_modules/HEAD");
      yield* f.fs.makeDirectory(`${f.worktree}/node_modules/refs`);
      yield* f.fs.symlink(`${f.root}/missing-objects`, `${f.worktree}/node_modules/objects`);
      const dangling = yield* select(f.worktree, ["node_modules"]);
      assert.equal(dangling.selected.length, 0);
      assert.equal(dangling.kept[0]?.reason, "nested-checkout");
    }).pipe(Effect.provide(dependencies), Effect.scoped),
  );

  it.effect("marks a 1001-file preview as entry-truncated with incomplete totals", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.forEach(
        Array.from({ length: 1001 }, (_, i) => i),
        (i) => f.write(`file-${i}.tsbuildinfo`),
        { concurrency: 32, discard: true },
      );
      const select = yield* makeSelect;
      const result = yield* select(f.worktree, ["*.tsbuildinfo"]);
      assert.isTrue(result.entriesTruncated);
      assert.isFalse(result.measurementComplete);
      assert.isNull(result.freedBytes);
      assert.equal(result.selected.length, 1000);
    }).pipe(Effect.provide(dependencies), Effect.scoped),
  );

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
        assert.isFalse(result.entriesTruncated);
        assert.equal(
          yield* f.fs.readFileString(`${f.worktree}/node_modules/pkg/index.js`),
          "synthetic payload",
        );
      }).pipe(Effect.provide(dependencies), Effect.scoped),
  );

  it.effect("measures pnpm candidates using the worktree manifest and store device", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write("node_modules/.pnpm/pkg/index.js", "x".repeat(8192));
      yield* f.write(
        "node_modules/.modules.yaml",
        JSON.stringify({ storeDir: f.root, virtualStoreDir: ".pnpm" }),
      );
      const stat = yield* f.fs.stat(`${f.worktree}/node_modules/.pnpm/pkg/index.js`);
      const blocks = Option.match(stat.blocks, {
        onSome: (value) => Number(value * 512n),
        onNone: () => Number(stat.size),
      });
      const manifest = yield* f.fs.stat(`${f.worktree}/node_modules/.modules.yaml`);
      const manifestBlocks = Option.match(manifest.blocks, {
        onSome: (value) => Number(value * 512n),
        onNone: () => Number(manifest.size),
      });
      for (const sameDevice of [true, false]) {
        const select = yield* makeSelect.pipe(
          Effect.provide(Layer.fresh(measurementLayer)),
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            stat: (file) =>
              f.fs
                .stat(file)
                .pipe(
                  Effect.map((info) =>
                    !sameDevice && file === f.root ? { ...info, dev: info.dev + 1n } : info,
                  ),
                ),
          }),
        );
        const nested = yield* select(f.worktree, ["node_modules/.pnpm/pkg"]);
        assert.equal(nested.freedBytes, sameDevice ? 0 : blocks);
        assert.equal(nested.selected.length, 1);
        const whole = yield* select(f.worktree, ["node_modules"]);
        assert.equal(whole.freedBytes, manifestBlocks + (sameDevice ? 0 : blocks));
      }
    }).pipe(Effect.provide(dependencies), Effect.scoped),
  );

  it.effect("verifies the reviewer's 100002-file candidate under the raised limit", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write("node_modules/template");
      const info = yield* f.fs.stat(`${f.worktree}/node_modules/template`);
      const regular = yield* f.fs.readLink(`${f.worktree}/node_modules/template`).pipe(Effect.flip);
      const storage = yield* StorageCleanup.StorageCleanup;
      const select = yield* makeSelect.pipe(
        Effect.provideService(StorageCleanup.StorageCleanup, {
          ...storage,
          measureWorktree: () => Effect.succeed(0),
        }),
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          readDirectory: (file) =>
            file === `${f.worktree}/node_modules`
              ? Effect.succeed(Array.from({ length: 100002 }, (_, i) => `synthetic-${i}`))
              : f.fs.readDirectory(file),
          readLink: (file) =>
            file.includes("/synthetic-") ? Effect.fail(regular) : f.fs.readLink(file),
          stat: (file) => (file.includes("/synthetic-") ? Effect.succeed(info) : f.fs.stat(file)),
        }),
      );
      const result = yield* select(f.worktree, ["node_modules"]);
      assert.equal(result.selected.length, 1);
      assert.isTrue(result.measurementComplete);
    }).pipe(Effect.provide(dependencies), Effect.scoped),
  );

  it.effect(
    "keeps a candidate when verification exceeds its budget instead of silently omitting it",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        for (let i = 0; i < 10; i++) yield* f.write(`dist/file-${i}`);
        const select = yield* makeSelect.pipe(
          Effect.provideService(SelectionLimits, {
            verificationEntries: 5,
            traversalEntries: 1000,
            reportEntries: 1000,
          }),
        );
        const result = yield* select(f.worktree, ["dist"]);
        assert.equal(result.selected.length, 0);
        assert.equal(result.kept[0]?.reason, "too-large-to-verify");
        assert.include(result.kept[0]?.detail ?? "", "4 files");
        assert.isFalse(result.measurementComplete);
      }).pipe(Effect.provide(dependencies), Effect.scoped),
  );

  it.effect("keeps a timed-out candidate and marks totals incomplete", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write("dist/output");
      const entered = yield* Deferred.make<void>();
      const storage = yield* StorageCleanup.StorageCleanup;
      const select = yield* makeSelect.pipe(
        Effect.provideService(StorageCleanup.StorageCleanup, {
          ...storage,
          measureWorktree: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      );
      const running = yield* select(f.worktree, ["dist"]).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("30 seconds");
      const result = yield* Fiber.join(running);
      assert.equal(result.selected.length, 0);
      assert.equal(result.kept[0]?.reason, "too-large-to-verify");
      assert.include(result.kept[0]?.detail ?? "", "1 files");
      assert.isNull(result.freedBytes);
      assert.isFalse(result.measurementComplete);
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
    "remembers per-pattern approvals and previews settled, empty and unsettled worktrees with honest hardlink bytes",
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
        const select = yield* makeSelect;
        const shared = yield* select(f.worktree, ["dist/shared"]);
        assert.equal(shared.selected.length, 1);
        assert.equal(shared.freedBytes, 0);
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
        let threads = [
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
          assert.equal((yield* approvals.review(input)).status, "pending");
          assert.deepEqual((yield* cleanup.preview({ ...input, list: "approved" })).patterns, []);
          assert.equal(
            (yield* approvals.approve({ ...input, patterns: [" dist ", "not-declared"] })).status,
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
          yield* f.write("info-only/output");
          yield* f.fs.writeFileString(
            `${f.worktree}/.gitignore`,
            "dist/\nnode_modules/\ninfo-only/\n",
          );
          yield* f.fs.writeFileString(
            `${f.root}/styal.json`,
            JSON.stringify({ worktreeCleanup: ["info-only"] }),
          );
          yield* approvals.approve({ ...input, patterns: ["info-only"] });
          yield* f.fs.writeFileString(
            `${f.root}/styal.json`,
            JSON.stringify({ worktreeCleanup: ["**/info-only", "info-only"] }),
          );
          const overlapping = yield* cleanup.preview({ ...input, list: "declared" });
          const overlap = overlapping.worktrees.find((entry) => entry.worktreePath === f.worktree)!
            .selected[0]!;
          assert.deepEqual(overlap.patterns, ["**/info-only", "info-only"]);
          assert.equal(overlap.pattern, "info-only");
          assert.equal(overlap.patternStatus, "approved");
          assert.isFalse(overlapping.worktreesTruncated);
          yield* approvals.revoke({ ...input, pattern: "info-only" });
          yield* f.fs.writeFileString(
            `${f.root}/styal.json`,
            JSON.stringify({ worktreeCleanup: ["dist", "node_modules"] }),
          );
          const pending = yield* approvals.review(input);
          assert.equal(pending.status, "pending");
          assert.deepEqual(pending.declared, [
            { pattern: "dist", status: "approved" },
            { pattern: "node_modules", status: "pending" },
          ]);
          assert.deepEqual((yield* cleanup.preview({ ...input, list: "approved" })).patterns, [
            "dist",
          ]);
          yield* f.write("node_modules/output");
          const declaredPreview = yield* cleanup.preview({ ...input, list: "declared" });
          const candidates = declaredPreview.worktrees.find(
            (entry) => entry.worktreePath === f.worktree,
          )!.selected;
          assert.equal(
            candidates.find((entry) => entry.pattern === "dist")?.patternStatus,
            "approved",
          );
          assert.equal(
            candidates.find((entry) => entry.pattern === "node_modules")?.patternStatus,
            "pending",
          );
          yield* approvals.approve({ ...input, patterns: ["node_modules"] });
          yield* f.fs.writeFileString(
            `${f.root}/styal.json`,
            JSON.stringify({ worktreeCleanup: [" node_modules ", "dist", "dist"] }),
          );
          const reordered = yield* approvals.review(input);
          assert.equal(reordered.status, "approved");
          assert.deepEqual(
            reordered.declared.map((entry) => entry.pattern),
            ["node_modules", "dist"],
          );
          yield* f.fs.writeFileString(
            `${f.root}/styal.json`,
            JSON.stringify({ worktreeCleanup: ["dist"] }),
          );
          const subset = yield* approvals.review(input);
          assert.equal(subset.status, "approved");
          assert.equal(subset.approvedNotDeclared[0]?.pattern, "node_modules");
          assert.deepEqual((yield* cleanup.preview({ ...input, list: "approved" })).patterns, [
            "dist",
          ]);
          yield* f.fs.writeFileString(`${f.root}/styal.json`, "{}");
          const absent = yield* approvals.review(input);
          assert.equal(absent.status, "none");
          assert.equal(absent.approvedNotDeclared.length, 2);
          yield* f.fs.writeFileString(
            `${f.root}/styal.json`,
            JSON.stringify({ worktreeCleanup: ["node_modules"] }),
          );
          assert.equal((yield* approvals.review(input)).status, "approved");
          assert.deepEqual((yield* cleanup.preview({ ...input, list: "approved" })).patterns, [
            "node_modules",
          ]);
          assert.equal(
            (yield* approvals.revoke({ ...input, pattern: " node_modules " })).status,
            "pending",
          );
          assert.deepEqual((yield* cleanup.preview({ ...input, list: "approved" })).patterns, []);
          assert.equal(
            (yield* approvals.revoke({ ...input, pattern: "dist" })).approvedNotDeclared.length,
            0,
          );
          const notDeclared = yield* approvals.approve({
            ...input,
            patterns: ["dist", " toString ", "dist"],
          });
          assert.equal(notDeclared.status, "pending");
          assert.deepEqual(notDeclared.notDeclared, ["dist", "toString"]);
          assert.equal((yield* approvals.review(input)).approvedNotDeclared.length, 0);
          yield* approvals.approve({ ...input, patterns: ["node_modules"] });
          const forgotten = yield* approvals.revoke({ ...input, pattern: null });
          assert.equal(forgotten.status, "pending");
          assert.equal(forgotten.approvedNotDeclared.length, 0);
          const saved = yield* (yield* Settings.ServerSettingsService).getSettings;
          assert.deepEqual(saved.worktreeCleanupApprovals, {});
          assert.deepEqual(saved.projectFileActionApprovals, {});
          threads = Array.from({ length: 201 }, (_, index) =>
            shell({
              id: ThreadId.make(`cap-${index}`),
              worktreePath: `${f.root}/unmanaged-${index}`,
            }),
          );
          const capped = yield* cleanup.preview({ ...input, list: "declared" });
          assert.isTrue(capped.worktreesTruncated);
          assert.equal(capped.worktrees.length, 200);
          assert.isTrue(capped.worktrees.every((entry) => !entry.entriesTruncated));
          assert.isTrue(
            capped.worktrees.every(
              (entry) => entry.freedBytes === null && !entry.measurementComplete,
            ),
          );
        }).pipe(Effect.provide(service));
      }).pipe(Effect.provide(dependencies), Effect.scoped),
  );
});

const approvalProjectsLayer = Layer.mock(ProjectService.ProjectService)({
  getById: (id) =>
    Effect.succeedSome({
      id,
      title: "Fixture",
      workspaceRoot: `/synthetic/${id}`,
      repositoryIdentity: {
        canonicalKey: "github.com/acme/shared",
        rootPath: `/synthetic/${id}`,
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/acme/shared.git",
        },
      },
      faviconPath: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    }),
});
const approvalConfigLayer = Layer.mock(ProjectConfigLoader.ProjectConfigLoader)({
  load: () =>
    Effect.succeed({
      status: "valid",
      source: "styal.json",
      config: { source: "styal.json", actions: [], worktreeCleanup: ["dist", "node_modules"] },
      legacyScripts: [],
      issues: [],
    }),
});

it.effect("separates approvals for different project ids with the same repository identity", () =>
  Effect.gen(function* () {
    const approvals = yield* Approvals.Approvals;
    yield* approvals.approve({ projectId: ProjectId.make("a"), patterns: ["dist"] });
    assert.equal(
      (yield* approvals.review({ projectId: ProjectId.make("b") })).declared[0]?.status,
      "pending",
    );
  }).pipe(
    Effect.provide(
      Approvals.layer.pipe(
        Layer.provide(
          Layer.mergeAll(approvalProjectsLayer, approvalConfigLayer, Settings.layerTest()),
        ),
      ),
    ),
  ),
);

it.effect("does not restore dist when approving node_modules interleaves with revoking dist", () =>
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    const reached = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let gated = false;
    const wrapped = {
      ...settings,
      modifySettings: (patch: Parameters<typeof settings.modifySettings>[0]) => {
        if (!gated) {
          gated = true;
          return Deferred.succeed(reached, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(settings.modifySettings(patch)),
          );
        }
        return settings.modifySettings(patch);
      },
      updateSettings: (patch: Parameters<typeof settings.updateSettings>[0]) => {
        if (!gated) {
          gated = true;
          return Deferred.succeed(reached, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(settings.updateSettings(patch)),
          );
        }
        return settings.updateSettings(patch);
      },
    };
    const base = Approvals.layer.pipe(
      Layer.provide(Layer.mergeAll(approvalProjectsLayer, approvalConfigLayer)),
    );
    const initial = yield* Approvals.Approvals.pipe(Effect.provide(base));
    const projectId = ProjectId.make("race");
    yield* initial.approve({ projectId, patterns: ["dist"] });
    const approvals = yield* Approvals.Approvals.pipe(
      Effect.provide(base),
      Effect.provideService(Settings.ServerSettingsService, wrapped),
    );
    const approving = yield* approvals
      .approve({ projectId, patterns: ["node_modules"] })
      .pipe(Effect.forkChild);
    yield* Deferred.await(reached);
    yield* approvals.revoke({ projectId, pattern: "dist" });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(approving);
    assert.deepEqual((yield* initial.review({ projectId })).declared, [
      { pattern: "dist", status: "pending" },
      { pattern: "node_modules", status: "approved" },
    ]);
  }).pipe(Effect.provide(Settings.layerTest()), Effect.scoped),
);
