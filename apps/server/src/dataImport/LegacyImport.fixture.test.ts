// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - loads a generated fixture from disk.
/**
 * Imports a data directory produced by a real T3 Code server and compares the
 * result with what that server itself reported. Regenerate the fixture with
 * `apps/server/scripts/generate-t3-import-fixture.ts`.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService, layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import { makeLegacyImportService } from "./LegacyImport.ts";

// The nightly T3 Code import check points this at data generated from upstream `main`.
const fixtureDir =
  process.env.STYAL_T3_IMPORT_FIXTURE ?? NodePath.join(import.meta.dirname, "testFixtures/t3-code");

interface Manifest {
  readonly serverRevision: string;
  readonly importedThreadIds: ReadonlyArray<string>;
  readonly deletedThreadIds: ReadonlyArray<string>;
  readonly settings: Readonly<Record<string, unknown>>;
}

type Json = Record<string, unknown>;

interface T3View {
  readonly snapshot: {
    readonly projects: ReadonlyArray<Json>;
    readonly threads: ReadonlyArray<Json>;
  };
  readonly threads: Readonly<Record<string, Json>>;
}

const readJson = <T>(name: string): T =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(fixtureDir, name), "utf8")) as T;

/** Rebuilds the T3 Code state directory the importer reads from the committed fixture. */
function prepareSourceStateDir(): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-import-fixture-"));
  const database = new NodeSqlite.DatabaseSync(NodePath.join(directory, "state.sqlite"));
  database.exec(NodeFS.readFileSync(NodePath.join(fixtureDir, "state.sql"), "utf8"));
  database.close();
  NodeFS.cpSync(NodePath.join(fixtureDir, "attachments"), NodePath.join(directory, "attachments"), {
    recursive: true,
  });
  NodeFS.copyFileSync(
    NodePath.join(fixtureDir, "settings.json"),
    NodePath.join(directory, "settings.json"),
  );
  return directory;
}

/**
 * Thread fields whose T3 Code value is not expected in styal, as paths within
 * a thread with array indexes written `[]`.
 */
const EXPECTED_DIFFERENCES: ReadonlyMap<string, string> = new Map([
  ["session", "Live provider sessions are not imported; the continuation resumes them instead."],
  [
    "activities[].payload",
    "T3 Code's thread API reduces tool payloads; styal keeps them in full. Payloads are compared with the stored source events instead.",
  ],
  [
    "latestTurn.startedAt",
    "The importer dates a turn's start from the session reaching running, not from the request.",
  ],
  [
    "updatedAt",
    "T3 Code's snapshot endpoint keeps the settle time after un-settling; the stored event carries the later time.",
  ],
]);

/** Activity kinds that describe a live session and are left out of imported history. */
const LIVE_SESSION_ACTIVITY_KINDS = new Set(["context-window.updated"]);

/**
 * Compares every field T3 Code reported with the same field in styal and
 * returns the paths that differ or that styal lacks.
 */
function compareShared(expected: unknown, actual: unknown, path: string, out: string[]): void {
  if (EXPECTED_DIFFERENCES.has(path.replace(/\[\d+\]/g, "[]"))) return;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      out.push(
        `${path}: expected ${expected.length} items, got ${JSON.stringify(actual)?.slice(0, 200)}`,
      );
      return;
    }
    expected.forEach((item, index) => compareShared(item, actual[index], `${path}[${index}]`, out));
    return;
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object") {
      out.push(`${path}: expected an object, got ${JSON.stringify(actual)}`);
      return;
    }
    for (const [key, value] of Object.entries(expected)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      if (!(key in actual)) {
        if (!EXPECTED_DIFFERENCES.has(childPath.replace(/\[\d+\]/g, "[]"))) {
          out.push(`${childPath}: missing in styal`);
        }
        continue;
      }
      compareShared(value, (actual as Json)[key], childPath, out);
    }
    return;
  }
  if (expected !== actual) {
    out.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Activity payloads exactly as T3 Code stored them, keyed by activity id. */
function readSourceActivityPayloads(sourceStateDir: string): ReadonlyMap<string, unknown> {
  const database = new NodeSqlite.DatabaseSync(NodePath.join(sourceStateDir, "state.sqlite"), {
    readOnly: true,
  });
  const rows = database
    .prepare(
      "SELECT payload_json AS payloadJson FROM orchestration_events WHERE event_type = 'thread.activity-appended'",
    )
    .all();
  database.close();
  return new Map(
    rows.map((row) => {
      const { activity } = JSON.parse(String(row.payloadJson)) as {
        activity: { id: string; payload: unknown };
      };
      return [activity.id, activity.payload] as const;
    }),
  );
}

/** Resume cursors T3 Code stored, as `[threadId, cursor]` pairs sorted by thread. */
function readSourceContinuations(sourceStateDir: string): Array<[string, unknown]> {
  const database = new NodeSqlite.DatabaseSync(NodePath.join(sourceStateDir, "state.sqlite"), {
    readOnly: true,
  });
  const rows = database
    .prepare(
      "SELECT thread_id AS threadId, resume_cursor_json AS resumeCursorJson FROM provider_session_runtime WHERE resume_cursor_json IS NOT NULL ORDER BY thread_id",
    )
    .all();
  database.close();
  return rows.map((row) => [String(row.threadId), JSON.parse(String(row.resumeCursorJson))]);
}

/** T3 Code's final view of a thread: detail arrays plus the snapshot's latest thread fields. */
function expectedThread(view: T3View, threadId: string): Json {
  const detail = view.threads[threadId]!;
  const summary = view.snapshot.threads.find((thread) => thread.id === threadId)!;
  const scalars = Object.fromEntries(
    Object.entries(summary).filter(([, value]) => !Array.isArray(value)),
  );
  const activities = (detail.activities as ReadonlyArray<Json>).filter(
    (activity) => !LIVE_SESSION_ACTIVITY_KINDS.has(activity.kind as string),
  );
  return { ...detail, ...scalars, activities };
}

const importLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionPipelineLive,
  OrchestrationProjectionSnapshotQueryLive,
  serverSettingsLayerTest(),
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-import-fixture-target-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(importLayer)("T3 Code import from a generated data directory", (it) => {
  it.effect(
    "imports threads, attachments, preferences, and continuations as T3 Code kept them",
    () =>
      Effect.gen(function* () {
        const manifest = readJson<Manifest>("manifest.json");
        const view = readJson<T3View>("t3-view.json");
        const sourceStateDir = prepareSourceStateDir();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(sourceStateDir, { recursive: true, force: true })),
        );

        const service = yield* makeLegacyImportService({
          sourceStateDir,
          stopActiveProviderSession: () => Effect.void,
        });
        const result = yield* service.importData({
          projectIds: view.snapshot.projects.map((project) => project.id as string),
          includeSettings: true,
        });

        assert.equal(result.importedProjectCount, view.snapshot.projects.length);
        assert.equal(result.importedThreadCount, manifest.importedThreadIds.length);
        assert.equal(result.skippedAttachmentCount, 0);
        assert.equal(result.settings?.status, "imported");

        const readModel = yield* ProjectionSnapshotQuery.pipe(
          Effect.flatMap((snapshots) => snapshots.getSnapshot()),
        );
        const importedThreads = new Map(readModel.threads.map((thread) => [thread.id, thread]));
        const sourceActivities = readSourceActivityPayloads(sourceStateDir);
        const differences: string[] = [];
        for (const threadId of manifest.importedThreadIds) {
          const imported = importedThreads.get(ThreadId.make(threadId));
          if (imported === undefined || imported.deletedAt !== null) {
            differences.push(`${threadId}: not imported`);
            continue;
          }
          const threadDifferences: string[] = [];
          compareShared(expectedThread(view, threadId), imported, "", threadDifferences);
          for (const activity of imported.activities) {
            compareShared(
              sourceActivities.get(activity.id),
              activity.payload,
              `activities[${activity.id}].payload`,
              threadDifferences,
            );
          }
          differences.push(...threadDifferences.map((difference) => `${threadId}.${difference}`));
        }
        for (const threadId of manifest.deletedThreadIds) {
          const imported = importedThreads.get(ThreadId.make(threadId));
          if (imported !== undefined && imported.deletedAt === null) {
            differences.push(`${threadId}: deleted thread was imported`);
          }
        }
        compareShared(view.snapshot.projects, readModel.projects, "projects", differences);
        assert.deepEqual(differences, []);

        // Attachments arrive byte for byte.
        const config = yield* ServerConfig;
        for (const name of NodeFS.readdirSync(NodePath.join(fixtureDir, "attachments"))) {
          assert.deepEqual(
            NodeFS.readFileSync(NodePath.join(config.attachmentsDir, name)),
            NodeFS.readFileSync(NodePath.join(fixtureDir, "attachments", name)),
            name,
          );
        }

        // Preferences arrive; provider binaries stay local to this environment.
        const settings = yield* ServerSettingsService.pipe(
          Effect.flatMap((service) => service.getSettings),
        );
        for (const [key, value] of Object.entries(manifest.settings)) {
          assert.deepEqual(settings[key as keyof typeof settings], value, key);
        }
        assert.notEqual(settings.providers.codex.binaryPath, "/tmp/t3-import-fixture/bin/codex");

        // Every surviving thread keeps the provider conversation it can resume.
        const sql = yield* SqlClient.SqlClient;
        const continuations = yield* sql<{
          readonly threadId: string;
          readonly resumeCursorJson: string;
        }>`SELECT thread_id AS "threadId", resume_cursor_json AS "resumeCursorJson" FROM provider_session_runtime ORDER BY thread_id`;
        assert.deepEqual(
          continuations.map((row) => [row.threadId, JSON.parse(row.resumeCursorJson)]),
          readSourceContinuations(sourceStateDir).filter(
            ([threadId]) => !manifest.deletedThreadIds.includes(threadId),
          ),
        );
      }).pipe(Effect.scoped),
  );
});
