// @effect-diagnostics nodeBuiltinImport:off -- Windows evidence installs a real pnpm fixture and hashes its isolated store.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2ProviderSessionJson,
  ProviderSessionId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProjectId,
  RunId,
  type OrchestrationProjectShell,
  type StorageCleanupReportEntry,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { fixture, nodeLayer, shell } from "./fixtures.testkit.ts";
import * as Settings from "../serverSettings.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ServerConfig from "../config.ts";
import { withWindowsLock } from "./windowsLock.testkit.ts";
import { makeSweep } from "./Sweep.ts";
import { DeletionLimits } from "./Deletion.ts";
import { makeConsume } from "./Stripped.ts";
import migration from "../persistence/ForkMigrations/015_WorktreeStripped.ts";
import { makeWorkspaceLease } from "../workspace/workspaceLease.ts";
import { TestClock } from "effect/testing";
import * as NodeNet from "node:net";
import { ThreadId } from "@t3tools/contracts";

const encodeSession = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);
const encode = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2AppThreadJson));
const setup = Effect.gen(function* () {
  const f = yield* fixture;
  const sql = yield* SqlClient.SqlClient;
  yield* migration;
  yield* sql`CREATE TABLE orchestration_v2_projection_threads (payload_json TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_provider_sessions (payload_json TEXT, status TEXT)`;
  yield* f.fs.writeFileString(
    `${f.root}/styal.json`,
    '{"regenerableFiles":["dist","node_modules"]}',
  );
  yield* f.command(f.root, ["add", "styal.json"]);
  yield* f.command(f.root, ["commit", "-m", "fixture: declare cleanup"]);
  const project: OrchestrationProjectShell = {
    id: ProjectId.make("project-1"),
    title: "Synthetic",
    workspaceRoot: f.root,
    repositoryIdentity: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    faviconPath: null,
    additionalInstructions: null,
    projectIcon: null,
    scripts: [],
    pinnedAt: null,
    pinOrderKey: null,
    archivedAt: null,
    createdAt: "1970-01-01T00:00:00Z",
    updatedAt: "1970-01-01T00:00:00Z",
  };
  let threads = [
    shell({
      worktreePath: f.worktree,
      branch: "quiet",
      settledOverride: "settled",
      settledAt: DateTime.makeUnsafe(0),
    }),
  ];
  let afterRead = Effect.void;
  let projectList = [project];
  let terminal = false;
  let live = false;
  const persist = Effect.fn("fixture.persist")(function* () {
    yield* sql`DELETE FROM orchestration_v2_projection_threads`;
    for (const thread of threads)
      yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${yield* encode(OrchestrationV2AppThreadJson.make({ ...thread, lastVisitedAt: thread.lastVisitedAt ?? null }))})`;
  });
  yield* persist();
  yield* TestClock.adjust("25 hours");
  const layers = Layer.mergeAll(
    Layer.succeed(ServerConfig.ServerConfig, f.config),
    Layer.succeed(GitVcsDriver.GitVcsDriver, f.git),
    Settings.layerTest({ regenerableFileCleanupMigrated: true }),
    Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.sync(() => projectList) }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: () =>
        Effect.succeed({
          schemaVersion: 1,
          snapshotSequence: 0,
          projects: [],
          threads,
          archivedThreads: [],
        }),
      getThreadShell: (id) =>
        Effect.sync(() => threads.find((thread) => thread.id === id) ?? null).pipe(
          Effect.tap(() => afterRead),
        ),
    }),
    Layer.mock(ProviderSessions.ProviderSessionManagerV2)({
      isLive: () => Effect.sync(() => live),
    }),
  );
  return {
    ...f,
    project,
    persist,
    layers,
    sql,
    setProjects: (next: OrchestrationProjectShell[]) => {
      projectList = next;
    },
    setAfterRead: (effect: Effect.Effect<void>) => {
      afterRead = effect;
    },
    setThreads: (next: OrchestrationV2ThreadShell[]) => {
      threads = next;
    },
    threads: () => threads,
    terminal: () => terminal,
    setTerminal: (value: boolean) => {
      terminal = value;
    },
    setLive: (value: boolean) => {
      live = value;
    },
  };
});

const testLayers = Layer.mergeAll(nodeLayer, NodeSqliteClient.layer({ filename: ":memory:" }));

it.effect.each(["canonical", "aliased"])(
  "strips once despite an unavailable unrelated project and consumes the record (%s project root)",
  (mode) =>
    Effect.gen(function* () {
      const f = yield* setup;
      const projectRoot = mode === "aliased" ? `${f.base}/project-alias` : f.root;
      if (mode === "aliased") yield* f.fs.symlink(f.root, projectRoot);
      f.setProjects([
        { ...f.project, workspaceRoot: projectRoot },
        { ...f.project, id: ProjectId.make("unavailable"), workspaceRoot: `${f.base}/missing` },
      ]);
      yield* f.command(f.root, ["branch", "-m", "trunk"]);
      yield* f.command(f.root, ["update-ref", "refs/remotes/origin/trunk", "HEAD"]);
      yield* f.command(f.root, [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/trunk",
      ]);
      yield* f.command(f.root, ["checkout", "-b", "feature"]);
      yield* f.fs.writeFileString(`${f.root}/styal.json`, '{"regenerableFiles":["cache"]}');
      yield* f.command(f.root, ["add", "styal.json"]);
      yield* f.command(f.root, ["commit", "-m", "fixture: ignored feature patterns"]);
      yield* f.write("styal.json", '{"regenerableFiles":["cache"]}');
      yield* f.write("cache/keep");
      yield* f.write("dist/output");
      const report: StorageCleanupReportEntry[] = [];
      yield* Effect.gen(function* () {
        const sweep = yield* makeSweep;
        yield* sweep(f.terminal, report);
        expect(report.map((entry) => entry.path)).toEqual([f.path.join(f.worktree, "dist")]);
        expect(yield* f.fs.exists(`${f.worktree}/dist`)).toBe(false);
        expect(yield* f.fs.exists(`${f.worktree}/cache/keep`)).toBe(true);
        expect((yield* f.sql`SELECT * FROM worktree_stripped`).length).toBe(1);
        yield* f.write("dist/recreated");
        yield* sweep(f.terminal, report);
        expect(yield* f.fs.exists(`${f.worktree}/dist/recreated`)).toBe(true);
        const consume = yield* makeConsume;
        expect(yield* consume(f.worktree)).toBe(true);
        expect(yield* consume(f.worktree)).toBe(false);
      }).pipe(Effect.provide(f.layers));
    }).pipe(Effect.provide(testLayers), Effect.scoped),
);

it.effect.each([
  "unsettled",
  "active",
  "background",
  "queued",
  "terminal",
  "live-session",
  "recent",
  "disabled",
  "migration-incomplete",
  "feature-only",
  "uncommitted",
  "worktree-only",
  "withdrawn",
  "invalid",
  "root",
  "unreferenced",
  "missing-project",
  "missing-project-record",
  "shared-projects",
  "no-default-branch",
  "unpushed-checkout",
  "unpushed-worktree",
] as const)("keeps files for %s", (mode) =>
  Effect.gen(function* () {
    const f = yield* setup;
    yield* f.write("dist/output");
    const initial = f.threads()[0]!;
    const overrides =
      mode === "unsettled"
        ? { settledOverride: null }
        : mode === "active"
          ? { activeRunId: RunId.make("running") }
          : mode === "background"
            ? { pendingBackgroundTasks: [{ taskId: "child", kind: "subagent" as const }] }
            : mode === "queued"
              ? { status: "queued" as const }
              : mode === "recent"
                ? { latestUserMessageAt: DateTime.makeUnsafe(90_000_000) }
                : mode === "root"
                  ? { worktreePath: f.root }
                  : {};
    f.setThreads(mode === "unreferenced" ? [] : [{ ...initial, ...overrides }]);
    yield* f.persist();
    f.setTerminal(mode === "terminal");
    if (mode === "live-session") {
      f.setLive(true);
      const session = {
        id: ProviderSessionId.make("session"),
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "ready" as const,
        cwd: f.worktree,
        model: null,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: DateTime.makeUnsafe(0),
        updatedAt: DateTime.makeUnsafe(0),
        lastError: null,
      };
      const payload = yield* encodeSession(session);
      yield* f.sql`INSERT INTO orchestration_v2_projection_provider_sessions VALUES (${payload}, 'ready')`;
    }
    if (mode === "withdrawn")
      yield* f.fs.writeFileString(`${f.root}/styal.json`, '{"regenerableFiles":[]}');
    if (mode === "invalid")
      yield* f.fs.writeFileString(`${f.root}/styal.json`, '{"regenerableFiles":["**/*"]}');
    if (mode === "withdrawn" || mode === "invalid") {
      yield* f.command(f.root, ["add", "styal.json"]);
      yield* f.command(f.root, ["commit", "-m", "fixture: change cleanup"]);
    }
    if (mode === "feature-only" || mode === "worktree-only" || mode === "uncommitted") {
      yield* f.command(f.root, ["rm", "styal.json"]);
      yield* f.command(f.root, ["commit", "-m", "fixture: no cleanup on default"]);
      const cwd = mode === "worktree-only" ? f.worktree : f.root;
      if (mode !== "uncommitted") yield* f.command(cwd, ["checkout", "-b", "feature"]);
      yield* f.fs.writeFileString(`${cwd}/styal.json`, '{"regenerableFiles":["dist"]}');
      if (mode !== "uncommitted") {
        yield* f.command(cwd, ["add", "styal.json"]);
        yield* f.command(cwd, ["commit", "-m", "fixture: feature cleanup"]);
      }
    }
    if (mode === "missing-project-record") f.setProjects([]);
    if (mode === "shared-projects") {
      const otherProject = { ...f.project, id: ProjectId.make("other-project") };
      f.setProjects([f.project, otherProject]);
      f.setThreads([
        ...f.threads(),
        { ...initial, id: ThreadId.make("other-project-thread"), projectId: otherProject.id },
      ]);
      yield* f.persist();
    }
    if (mode === "no-default-branch") yield* f.command(f.root, ["branch", "-m", "feature"]);
    if (mode === "unpushed-checkout" || mode === "unpushed-worktree") {
      yield* f.fs.writeFileString(`${f.root}/styal.json`, '{"regenerableFiles":[]}');
      yield* f.command(f.root, ["add", "styal.json"]);
      yield* f.command(f.root, ["commit", "-m", "fixture: remote has no patterns"]);
      const origin = `${f.base}/origin.git`;
      yield* f.command(f.base, ["init", "--bare", "-b", "main", origin]);
      yield* f.command(f.root, ["remote", "add", "origin", origin]);
      yield* f.command(f.root, ["push", "-u", "origin", "main"]);
      yield* f.command(f.root, ["remote", "set-head", "origin", "main"]);
      const cwd = mode === "unpushed-checkout" ? f.root : f.worktree;
      if (mode === "unpushed-worktree") {
        yield* f.command(f.root, ["checkout", "-b", "feature"]);
        yield* f.command(f.worktree, ["checkout", "main"]);
      }
      yield* f.fs.writeFileString(`${cwd}/styal.json`, '{"regenerableFiles":["dist"]}');
      yield* f.command(cwd, ["add", "styal.json"]);
      yield* f.command(cwd, ["commit", "-m", "fixture: unpushed cleanup"]);
    }
    if (mode === "missing-project") yield* f.fs.remove(f.root, { recursive: true });
    yield* Effect.gen(function* () {
      if (mode === "disabled") {
        const settings = yield* Settings.ServerSettingsService;
        yield* settings.updateSettings({
          projectSettingsOverrides: { [f.project.id]: { cleanRegenerableFiles: false } },
        });
      }
      const sweep = yield* makeSweep;
      yield* sweep(f.terminal, []);
      expect(yield* f.fs.exists(`${f.worktree}/dist/output`)).toBe(true);
      expect(yield* f.sql`SELECT * FROM worktree_stripped`).toEqual([]);
    }).pipe(
      Effect.provide(
        mode === "migration-incomplete"
          ? Layer.merge(f.layers, Settings.layerTest({ regenerableFileCleanupMigrated: false }))
          : f.layers,
      ),
    );
  }).pipe(Effect.provide(testLayers), Effect.scoped),
);

it.effect("retries an inspection that exhausted its budget without thread or pattern changes", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    yield* f.write("dist/output");
    let exhausted = true;
    let probes = 0;
    yield* Effect.gen(function* () {
      const sweep = yield* makeSweep;
      const report: StorageCleanupReportEntry[] = [];
      yield* sweep(f.terminal, report);
      expect(yield* f.fs.exists(`${f.worktree}/dist/output`)).toBe(true);
      expect(report).toEqual([]);
      exhausted = false;
      yield* sweep(f.terminal, report);
      expect(yield* f.fs.exists(`${f.worktree}/dist`)).toBe(false);
      expect(report.map((entry) => entry.path)).toEqual([f.path.join(f.worktree, "dist")]);
    }).pipe(
      Effect.provide(f.layers),
      Effect.provideService(DeletionLimits, {
        entries: 1_000_000,
        now: () => (exhausted && ++probes > 1 ? 600_000 : 0),
      }),
    );
  }).pipe(Effect.provide(testLayers), Effect.scoped),
);

it.effect("rechecks threads under the exact turn-start lease", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    yield* f.write("dist/output");
    yield* Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const held = yield* (yield* makeWorkspaceLease)(
        f.worktree,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const sweep = yield* makeSweep;
      const read = yield* Deferred.make<void>();
      f.setAfterRead(Deferred.succeed(read, undefined).pipe(Effect.asVoid));
      const pending = yield* sweep(f.terminal, []).pipe(Effect.forkChild);
      yield* Deferred.await(read);
      f.setThreads([{ ...f.threads()[0]!, settledOverride: null }]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(held);
      yield* Fiber.join(pending);
      expect(yield* f.fs.exists(`${f.worktree}/dist/output`)).toBe(true);
    }).pipe(Effect.provide(f.layers));
  }).pipe(Effect.provide(testLayers), Effect.scoped),
);

it.effect.each(["/", "/.", "/../quiet", "symlink"])(
  "holds a worktree with a running thread at alias %s",
  (suffix) =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.write("dist/output");
      const alias = `${f.base}/worktrees-link`;
      if (suffix === "symlink") yield* f.linkDirectory(f.config.worktreesDir, alias);
      f.setThreads([
        ...f.threads(),
        shell({
          id: ThreadId.make("running-alias"),
          worktreePath: suffix === "symlink" ? `${alias}/fixture/quiet` : `${f.worktree}${suffix}`,
          status: "running",
          activeRunId: RunId.make("active"),
        }),
      ]);
      yield* f.persist();
      yield* Effect.gen(function* () {
        const sweep = yield* makeSweep;
        const report: StorageCleanupReportEntry[] = [];
        yield* sweep(f.terminal, report);
        expect(report).toEqual([]);
        expect(yield* f.fs.exists(`${f.worktree}/dist/output`)).toBe(true);
      }).pipe(Effect.provide(f.layers));
    }).pipe(Effect.provide(testLayers), Effect.scoped),
);

it.effect("serializes leases through a symbolic link to the same checkout", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    const alias = f.path.join(f.base, "checkout-link");
    yield* f.linkDirectory(f.worktree, alias);
    const real = yield* f.fs.realPath(alias);
    const lease = yield* makeWorkspaceLease.pipe(
      // Resolve the real fixture synchronously so lock ordering does not depend on I/O scheduling.
      Effect.provideService(FileSystem.FileSystem, {
        ...f.fs,
        realPath: (target) => Effect.succeed(target === alias ? real : target),
      }),
    );
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const events: string[] = [];
    const first = yield* lease(
      alias,
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.tap(() => Effect.sync(() => events.push("released"))),
      ),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const second = yield* lease(
      f.worktree,
      Effect.sync(() => events.push("second")),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    expect(events).toEqual(["released", "second"]);
  }).pipe(Effect.provide(testLayers), Effect.scoped),
);

it.effect("scans thread spellings once while cleaning multiple worktrees", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    const other = f.path.join(f.config.worktreesDir, "fixture/other");
    yield* f.command(f.root, ["worktree", "add", "--detach", other]);
    yield* f.write("dist/output");
    yield* f.fs.makeDirectory(`${other}/dist`);
    yield* f.fs.writeFileString(`${other}/dist/output`, "synthetic");
    f.setThreads([
      ...f.threads(),
      { ...f.threads()[0]!, id: ThreadId.make("other"), worktreePath: other },
    ]);
    yield* f.persist();
    let scans = 0;
    let patternReads = 0;
    const sql = new Proxy(f.sql, {
      apply(target, receiver, args) {
        if (Array.isArray(args[0]) && args[0].join("").includes("SELECT DISTINCT")) scans++;
        return Reflect.apply(target, receiver, args);
      },
    });
    yield* Effect.gen(function* () {
      const sweep = yield* makeSweep;
      const report: StorageCleanupReportEntry[] = [];
      yield* sweep(f.terminal, report);
      expect(report.map((entry) => entry.path)).toEqual([
        f.path.join(f.worktree, "dist"),
        f.path.join(other, "dist"),
      ]);
      expect(scans).toBe(1);
      expect(patternReads).toBe(1);
    }).pipe(
      Effect.provideService(GitVcsDriver.GitVcsDriver, {
        ...f.git,
        execute: (input) => {
          if (input.args.includes("show")) patternReads++;
          return f.git.execute(input);
        },
      }),
      Effect.provide(f.layers),
      Effect.provideService(SqlClient.SqlClient, sql),
    );
  }).pipe(Effect.provide(testLayers), Effect.scoped),
);

it.effect.each(["project-root", "git-directory", "root-link"] as const)(
  "never inspects a protected %s",
  (mode) =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.write("dist/output");
      if (mode === "project-root")
        f.setProjects([
          f.project,
          { ...f.project, id: ProjectId.make("nested-project"), workspaceRoot: f.worktree },
        ]);
      if (mode === "git-directory") {
        yield* f.fs.remove(`${f.worktree}/.git`);
        yield* f.command(f.worktree, ["init"]);
      }
      if (mode === "root-link") {
        yield* f.fs.rename(f.worktree, `${f.worktree}-target`);
        yield* f.linkDirectory(`${f.worktree}-target`, f.worktree);
      }
      const inspected: string[] = [];
      yield* Effect.gen(function* () {
        const sweep = yield* makeSweep;
        yield* sweep(f.terminal, []);
        expect(yield* f.fs.exists(`${f.worktree}/dist/output`)).toBe(true);
        expect(inspected).toEqual([]);
      }).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, {
          ...f.git,
          execute: (input) => {
            inspected.push(input.cwd);
            return f.git.execute(input);
          },
        }),
        Effect.provide(f.layers),
      );
    }).pipe(Effect.provide(testLayers), Effect.scoped),
);

it.effect("persists the stripped record before the first unlink", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    yield* f.write("dist/output");
    const connected = Promise.withResolvers<NodeNet.Socket>();
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => NodeNet.createServer(connected.resolve)),
      (server) =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    yield* Effect.promise(
      () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
    );
    const address = server.address() as NodeNet.AddressInfo;
    const preload = `${f.base}/pause-before-removal.mjs`;
    yield* f.fs.writeFileString(
      preload,
      `
      import net from "node:net";
      const socket = net.connect(${address.port}, "127.0.0.1");
      socket.resume();
      await new Promise((resolve, reject) => {
        socket.once("end", resolve);
        socket.once("error", reject);
      });
    `,
    );
    yield* Effect.gen(function* () {
      const sweep = yield* makeSweep;
      const pending = yield* sweep(f.terminal, []).pipe(Effect.forkChild);
      const socket = yield* Effect.promise(() => connected.promise);
      const [beforeDelete, stillPresent] = yield* Effect.all([
        f.sql`SELECT 1 FROM worktree_stripped WHERE worktree_path = ${f.worktree}`,
        f.fs.exists(`${f.worktree}/dist/output`),
      ]).pipe(Effect.ensuring(Effect.sync(() => socket.end())));
      yield* Fiber.join(pending);
      expect(beforeDelete.length).toBe(1);
      expect(stillPresent).toBe(true);
    }).pipe(
      Effect.provide(f.layers),
      Effect.provideService(DeletionLimits, { entries: 1_000_000, helperPreload: preload }),
    );
    expect(yield* f.fs.exists(`${f.worktree}/dist`)).toBe(false);
  }).pipe(Effect.provide(testLayers), Effect.scoped),
);

it.effect("keeps a partial selection for a later complete inspection", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    yield* f.write("dist/output");
    for (let i = 0; i < 20; i++) yield* f.write(`node_modules/pkg-${i}`);
    let limited = true;
    yield* Effect.gen(function* () {
      const sweep = yield* makeSweep;
      const report: StorageCleanupReportEntry[] = [];
      yield* sweep(f.terminal, report);
      expect(report).toEqual([]);
      expect(yield* f.sql`SELECT * FROM worktree_stripped`).toEqual([]);
      expect(yield* f.fs.exists(`${f.worktree}/dist/output`)).toBe(true);
      limited = false;
      yield* sweep(f.terminal, report);
      expect(report.map((entry) => entry.path)).toEqual([
        f.path.join(f.worktree, "dist"),
        f.path.join(f.worktree, "node_modules"),
      ]);
    }).pipe(
      Effect.provide(f.layers),
      Effect.provideService(DeletionLimits, {
        get entries() {
          return limited ? 20 : 1_000_000;
        },
      }),
    );
  }).pipe(Effect.provide(testLayers), Effect.scoped),
);

it.effect("records stripping before permission failures and continues independent matches", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    yield* f.write("dist/output");
    yield* f.write("node_modules/output");
    if ((yield* HostProcess.Platform) === "win32") return;
    yield* f.fs.chmod(`${f.worktree}/dist`, 0o500);
    yield* Effect.addFinalizer(() => f.fs.chmod(`${f.worktree}/dist`, 0o700).pipe(Effect.orDie));
    const report: StorageCleanupReportEntry[] = [];
    yield* Effect.gen(function* () {
      const sweep = yield* makeSweep;
      yield* sweep(f.terminal, report);
      expect(report.find((entry) => entry.path === f.path.join(f.worktree, "dist"))?.outcome).toBe(
        "failed",
      );
      expect(
        report.find((entry) => entry.path === f.path.join(f.worktree, "node_modules"))?.outcome,
      ).toBe("removed");
      expect((yield* f.sql`SELECT * FROM worktree_stripped`).length).toBe(1);
      expect(yield* f.fs.exists(`${f.worktree}/dist/output`)).toBe(true);
      expect(yield* f.fs.exists(`${f.worktree}/node_modules`)).toBe(false);
    }).pipe(Effect.provide(f.layers));
  }).pipe(Effect.provide(testLayers), Effect.scoped),
);

it.effect.each(["separate-git-dir", "foreign-owner", "broken-registration", "nested-admin"])(
  "keeps an unowned or unregistered worktree: %s",
  (mode) =>
    Effect.gen(function* () {
      const f = yield* setup;
      if (mode === "separate-git-dir") {
        yield* f.fs.remove(`${f.worktree}/.git`);
        yield* f.command(f.worktree, ["init", "--separate-git-dir", `${f.base}/private-git`]);
      } else if (mode === "foreign-owner") {
        yield* f.command(f.root, ["worktree", "move", f.worktree, `${f.base}/original`]);
        const foreign = `${f.base}/foreign`;
        yield* f.fs.makeDirectory(foreign);
        yield* f.command(foreign, ["init", "-b", "main"]);
        yield* f.command(foreign, ["config", "user.name", "Fixture"]);
        yield* f.command(foreign, ["config", "user.email", "fixture@example.invalid"]);
        yield* f.fs.writeFileString(`${foreign}/.gitignore`, "dist/\n");
        yield* f.command(foreign, ["add", "."]);
        yield* f.command(foreign, ["commit", "-m", "fixture"]);
        yield* f.command(foreign, ["worktree", "add", "--detach", f.worktree]);
      } else {
        const admin = (yield* f.command(f.worktree, [
          "rev-parse",
          "--absolute-git-dir",
        ])).stdout.trimEnd();
        if (mode === "nested-admin") {
          const nested = `${admin}-group/entry`;
          yield* f.fs.makeDirectory(`${admin}-group`);
          yield* f.fs.rename(admin, nested);
          yield* f.fs.writeFileString(`${f.worktree}/.git`, `gitdir: ${nested}\n`);
          yield* f.fs.writeFileString(`${nested}/commondir`, "../../..\n");
          expect(
            (yield* f.command(f.worktree, ["rev-parse", "--show-toplevel"])).stdout.trimEnd(),
          ).toBe(f.worktree);
          expect(
            (yield* f.command(f.root, ["worktree", "list", "--porcelain", "-z"])).stdout,
          ).not.toContain(`worktree ${f.worktree}\0`);
        } else yield* f.fs.writeFileString(`${admin}/gitdir`, `${f.base}/unregistered/.git\n`);
      }
      yield* f.write("dist/output");
      yield* Effect.gen(function* () {
        const sweep = yield* makeSweep;
        yield* sweep(f.terminal, []);
        expect(yield* f.fs.readFileString(`${f.worktree}/dist/output`)).toBe("synthetic");
        expect(yield* f.sql`SELECT * FROM worktree_stripped`).toEqual([]);
      }).pipe(Effect.provide(f.layers));
    }).pipe(Effect.provide(testLayers), Effect.scoped),
);

it.effect("cleans regenerable files on Windows", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    yield* f.write("dist/output");
    const report: StorageCleanupReportEntry[] = [];
    yield* Effect.gen(function* () {
      const sweep = yield* makeSweep;
      yield* sweep(f.terminal, report);
    }).pipe(Effect.provide(f.layers), Effect.provideService(HostProcess.Platform, "win32"));
    expect(report.map((entry) => entry.outcome)).toEqual(["removed"]);
    expect(yield* f.fs.exists(`${f.worktree}/dist`)).toBe(false);
  }).pipe(Effect.provide(testLayers), Effect.scoped),
);

it.effect.each(["junction", "directory-symlink", "long-path", "allocated-file"] as const)(
  "Windows service cleanup preserves outside sentinels: %s",
  (mode) =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "win32") return;
      const f = yield* setup;
      const physical = yield* PhysicalFileSystem.PhysicalFileSystem;
      const outside = f.path.join(f.base, "outside");
      yield* f.fs.makeDirectory(outside);
      yield* f.fs.writeFileString(f.path.join(outside, "sentinel"), "untouched");
      const relative =
        mode === "long-path"
          ? `node_modules/${"nested-package/".repeat(24)}output`
          : "node_modules/output";
      yield* f.write(relative, "x".repeat(1024 * 1024));
      if (mode === "long-path")
        expect(f.path.join(f.worktree, relative).length).toBeGreaterThan(260);
      if (mode === "junction" || mode === "directory-symlink") {
        const link = f.path.join(f.worktree, "node_modules", "outside");
        yield* Effect.promise(() =>
          physical.symlink(outside, link, mode === "junction" ? "junction" : "dir"),
        );
        expect((yield* Effect.promise(() => physical.lstat(link))).isSymbolicLink()).toBe(true);
      }
      const report: StorageCleanupReportEntry[] = [];
      yield* Effect.gen(function* () {
        const sweep = yield* makeSweep;
        yield* sweep(f.terminal, report);
      }).pipe(Effect.provide(f.layers));
      expect(report.map((entry) => entry.outcome)).toEqual(["removed"]);
      expect(report[0]!.bytes).toBeGreaterThan(0);
      expect(yield* f.fs.exists(f.path.join(f.worktree, "node_modules"))).toBe(false);
      expect(yield* f.fs.readFileString(f.path.join(outside, "sentinel"))).toBe("untouched");
      expect(yield* f.fs.readDirectory(outside)).toEqual(["sentinel"]);
    }).pipe(Effect.provide(testLayers), Effect.scoped),
);

it.effect("Windows locked match fails safely, records stripping, and recovers after setup", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "win32") return;
    const f = yield* setup;
    yield* f.write("dist/locked", "locked bytes");
    yield* f.write("node_modules/output");
    yield* f.write("local.txt", "keep unignored");
    yield* Effect.gen(function* () {
      const sweep = yield* makeSweep;
      const report: StorageCleanupReportEntry[] = [];
      yield* Effect.gen(function* () {
        yield* withWindowsLock(f.path.join(f.worktree, "dist/locked"));
        yield* sweep(f.terminal, report);
        expect(
          report.find((entry) => entry.path === f.path.join(f.worktree, "dist"))?.outcome,
        ).toBe("failed");
        expect(
          report.find((entry) => entry.path === f.path.join(f.worktree, "node_modules"))?.outcome,
        ).toBe("removed");
        expect((yield* f.sql`SELECT * FROM worktree_stripped`).length).toBe(1);
        expect(yield* f.fs.exists(f.path.join(f.worktree, "dist/locked"))).toBe(true);
      }).pipe(Effect.scoped);
      expect(yield* f.fs.readFileString(f.path.join(f.worktree, "dist/locked"))).toBe(
        "locked bytes",
      );
      const consume = yield* makeConsume;
      expect(yield* consume(f.worktree)).toBe(true);
      const retry = yield* makeSweep;
      const recovered: StorageCleanupReportEntry[] = [];
      yield* retry(f.terminal, recovered);
      expect(recovered.map((entry) => entry.outcome)).toEqual(["removed"]);
      expect(yield* f.fs.exists(f.path.join(f.worktree, "dist"))).toBe(false);
      expect(yield* f.fs.readFileString(f.path.join(f.worktree, "local.txt"))).toBe(
        "keep unignored",
      );
    }).pipe(Effect.provide(f.layers));
  }).pipe(Effect.provide(testLayers), Effect.scoped),
);

it.effect("Windows service removes a real pnpm install without changing its store", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "win32") return;
    const f = yield* setup;
    const physical = yield* PhysicalFileSystem.PhysicalFileSystem;
    const store = f.path.join(f.base, "pnpm-store");
    yield* f.write(
      "package.json",
      JSON.stringify({ private: true, dependencies: { "is-number": "7.0.0" } }),
    );
    const output = yield* Effect.promise(
      () =>
        new Promise<string>((resolve, reject) => {
          NodeChildProcess.execFile(
            "vp",
            [
              "install",
              "--ignore-scripts",
              "--no-frozen-lockfile",
              "--",
              "--ignore-workspace",
              "--store-dir",
              store,
            ],
            { cwd: f.worktree },
            (error, stdout, stderr) =>
              error ? reject(new Error(`${error.message}\n${stdout}\n${stderr}`)) : resolve(stdout),
          );
        }),
    );
    expect(output).toContain("pnpm");
    expect(
      yield* f.fs.readFileString(f.path.join(f.worktree, "node_modules/is-number/package.json")),
    ).toContain('"version": "7.0.0"');
    expect(
      (yield* Effect.promise(() =>
        physical.lstat(f.path.join(f.worktree, "node_modules/is-number")),
      )).isSymbolicLink(),
    ).toBe(true);
    const snapshot = () =>
      Effect.promise(async () => {
        const entries: string[] = [];
        const visit = async (directory: string): Promise<void> => {
          for (const name of (await physical.readdir(directory)).sort()) {
            const file = f.path.join(directory, name);
            const stat = await physical.lstat(file);
            if (stat.isDirectory()) await visit(file);
            else {
              expect(stat.isFile()).toBe(true);
              entries.push(
                `${f.path.relative(store, file)}:${NodeCrypto.createHash("sha256")
                  .update(await physical.readFile(file))
                  .digest("hex")}`,
              );
            }
          }
        };
        await visit(store);
        return entries;
      });
    const before = yield* snapshot();
    expect(before.length).toBeGreaterThan(0);
    const report: StorageCleanupReportEntry[] = [];
    yield* Effect.gen(function* () {
      const sweep = yield* makeSweep;
      yield* sweep(f.terminal, report);
    }).pipe(Effect.provide(f.layers));
    expect(report.map((entry) => entry.outcome)).toEqual(["removed"]);
    expect(yield* f.fs.exists(f.path.join(f.worktree, "node_modules"))).toBe(false);
    expect(yield* snapshot()).toEqual(before);
    expect(yield* f.fs.exists(f.path.join(f.worktree, "package.json"))).toBe(true);
    expect(yield* f.fs.exists(f.path.join(f.worktree, "pnpm-lock.yaml"))).toBe(true);
  }).pipe(Effect.provide(testLayers), Effect.scoped),
);

it.effect("Windows keeps a case-only alias of a managed worktree", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "win32") return;
    const f = yield* setup;
    yield* f.write("dist/output", "keep alias bytes");
    const alias = f.worktree.toUpperCase();
    expect(alias).not.toBe(f.worktree);
    expect(yield* f.fs.realPath(alias)).toBe(f.worktree);
    f.setThreads([{ ...f.threads()[0]!, worktreePath: alias }]);
    yield* f.persist();
    const report: StorageCleanupReportEntry[] = [];
    yield* Effect.gen(function* () {
      const sweep = yield* makeSweep;
      yield* sweep(f.terminal, report);
    }).pipe(Effect.provide(f.layers));
    expect(report).toEqual([]);
    expect(yield* f.sql`SELECT * FROM worktree_stripped`).toEqual([]);
    expect(yield* f.fs.readFileString(f.path.join(f.worktree, "dist/output"))).toBe(
      "keep alias bytes",
    );
  }).pipe(Effect.provide(testLayers), Effect.scoped),
);
