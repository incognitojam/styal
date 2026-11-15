import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
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
import { makeSweep } from "./Sweep.ts";
import { DeletionLimits } from "./Deletion.ts";
import { makeConsume } from "./Stripped.ts";
import migration from "../persistence/ForkMigrations/015_WorktreeStripped.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { TestClock } from "effect/testing";
import { vi } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Observe the real unlink boundary in disposable repositories.
import * as NodeFSP from "node:fs/promises";
import { ThreadId } from "@t3tools/contracts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return { ...actual, unlink: vi.fn(actual.unlink) };
});

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
    '{"worktreeCleanup":["dist","node_modules"]}',
  );
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
    Settings.layerTest({
      worktreeCleanupApprovals: {
        "project-1": {
          dist: { approvedAt: "2026-01-01T00:00:00Z" },
          node_modules: { approvedAt: "2026-01-01T00:00:00Z" },
        },
      },
    }),
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

it.effect(
  "strips once after a day despite an unavailable unrelated project, then consumes the stripped record once",
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      f.setProjects([
        f.project,
        { ...f.project, id: ProjectId.make("unavailable"), workspaceRoot: `${f.base}/missing` },
      ]);
      yield* f.write("dist/output");
      const report: StorageCleanupReportEntry[] = [];
      yield* Effect.gen(function* () {
        const sweep = yield* makeSweep;
        yield* sweep(f.terminal, report);
        expect(report.map((entry) => entry.path)).toEqual([`${f.worktree}/dist`]);
        expect(yield* f.fs.exists(`${f.worktree}/dist`)).toBe(false);
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
  "other-project",
  "withdrawn",
  "invalid",
  "root",
  "unreferenced",
  "windows",
  "missing-project",
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
      yield* f.fs.writeFileString(`${f.root}/styal.json`, '{"worktreeCleanup":[]}');
    if (mode === "invalid")
      yield* f.fs.writeFileString(`${f.root}/styal.json`, '{"worktreeCleanup":["**/*"]}');
    if (mode === "missing-project") yield* f.fs.remove(f.root, { recursive: true });
    yield* Effect.gen(function* () {
      if (mode === "other-project") {
        const settings = yield* Settings.ServerSettingsService;
        yield* settings.updateSettings({
          worktreeCleanupApprovals: {
            "project-other": { dist: { approvedAt: "2026-01-01T00:00:00Z" } },
          },
        });
      }
      const sweep = yield* makeSweep;
      yield* sweep(f.terminal, []);
      expect(yield* f.fs.exists(`${f.worktree}/dist/output`)).toBe(true);
      expect(yield* f.sql`SELECT * FROM worktree_stripped`).toEqual([]);
    }).pipe(
      Effect.provide(f.layers),
      Effect.provideService(HostProcess.Platform, mode === "windows" ? "win32" : "linux"),
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
      expect(report.map((entry) => entry.path)).toEqual([`${f.worktree}/dist`]);
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
      const held = yield* withWorkspaceLease(
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

it.effect.each(["/", "/.", "/../quiet"])(
  "holds a worktree with a running thread at alias %s",
  (suffix) =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.write("dist/output");
      f.setThreads([
        ...f.threads(),
        shell({
          id: ThreadId.make("running-alias"),
          worktreePath: `${f.worktree}${suffix}`,
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
        yield* f.fs.symlink(`${f.worktree}-target`, f.worktree);
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
    const entered = yield* Deferred.make<void>();
    const release = Promise.withResolvers<void>();
    const unlink = vi.mocked(NodeFSP.unlink);
    const original = unlink.getMockImplementation()!;
    using _restore = {
      [Symbol.dispose]: () => {
        unlink.mockImplementation(original);
      },
    };
    unlink.mockImplementation((target) => {
      if (target === `${f.worktree}/dist/output`) {
        Deferred.doneUnsafe(entered, Effect.void);
        return release.promise.then(() => original(target));
      }
      return original(target);
    });
    yield* Effect.gen(function* () {
      const sweep = yield* makeSweep;
      const pending = yield* sweep(f.terminal, []).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const beforeDelete =
        yield* f.sql`SELECT 1 FROM worktree_stripped WHERE worktree_path = ${f.worktree}`.pipe(
          Effect.ensuring(Effect.sync(() => release.resolve())),
        );
      yield* Fiber.join(pending);
      expect(beforeDelete.length).toBe(1);
    }).pipe(Effect.provide(f.layers));
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
        `${f.worktree}/dist`,
        `${f.worktree}/node_modules`,
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
    yield* f.fs.chmod(`${f.worktree}/dist`, 0o500);
    yield* Effect.addFinalizer(() => f.fs.chmod(`${f.worktree}/dist`, 0o700).pipe(Effect.orDie));
    const report: StorageCleanupReportEntry[] = [];
    yield* Effect.gen(function* () {
      const sweep = yield* makeSweep;
      yield* sweep(f.terminal, report);
      expect(report.find((entry) => entry.path?.endsWith("/dist"))?.outcome).toBe("failed");
      expect(report.find((entry) => entry.path?.endsWith("/node_modules"))?.outcome).toBe(
        "removed",
      );
      expect((yield* f.sql`SELECT * FROM worktree_stripped`).length).toBe(1);
      expect(yield* f.fs.exists(`${f.worktree}/dist/output`)).toBe(true);
      expect(yield* f.fs.exists(`${f.worktree}/node_modules`)).toBe(false);
    }).pipe(Effect.provide(f.layers));
  }).pipe(Effect.provide(testLayers), Effect.scoped),
);
