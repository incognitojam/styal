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
import { makeConsume } from "./Stripped.ts";
import migration from "../persistence/ForkMigrations/015_WorktreeStripped.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { TestClock } from "effect/testing";

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
    Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([project]) }),
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
  "strips once after a day, writes the row before a failed delete, and consumes it once",
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
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
