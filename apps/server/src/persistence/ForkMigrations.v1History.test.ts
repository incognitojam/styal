import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { runAllMigrations } from "./ForkMigrations.ts";
import { runMigrations } from "./Migrations.ts";

const { UPSTREAM_DROP_ID } = vi.hoisted(() => ({ UPSTREAM_DROP_ID: 63 }));

// Until upstream's migration 63 arrives through intake, run its statements after the
// manifest's migrations so these tests exercise the order the fork depends on.
vi.mock("./Migrations.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./Migrations.ts")>();
  if (actual.migrationManifest.some(([id]) => id === UPSTREAM_DROP_ID)) return actual;
  const runMigrations = Effect.fn("runMigrationsWithUpstreamDrop")(function* (
    options: Parameters<typeof actual.runMigrations>[0] = {},
  ) {
    const executed = yield* actual.runMigrations(options);
    if (
      options.toMigrationInclusive !== undefined &&
      options.toMigrationInclusive < UPSTREAM_DROP_ID
    ) {
      return executed;
    }
    const sql = yield* SqlClient.SqlClient;
    const recorded = yield* sql`
      SELECT 1 FROM effect_sql_migrations WHERE migration_id = ${UPSTREAM_DROP_ID}
    `;
    if (recorded.length > 0) return executed;
    yield* sql`DROP TABLE IF EXISTS projection_thread_activities`;
    yield* sql`DROP TABLE IF EXISTS projection_turns`;
    yield* sql`DROP TABLE IF EXISTS projection_thread_proposed_plans`;
    yield* sql`DROP TABLE IF EXISTS projection_pending_approvals`;
    yield* sql`DROP TABLE IF EXISTS projection_state`;
    yield* sql`DROP TABLE IF EXISTS checkpoint_diff_blobs`;
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (${UPSTREAM_DROP_ID}, 'DropUnusedV1Projections')
    `;
    return executed;
  });
  return { ...actual, runMigrations };
});

const threadId = ThreadId.make("thread:v1-history");
const at = "2026-01-01T00:00:00.000Z";

const seedV1Thread = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project:v1-history', 'V1 history', '/synthetic/project', '[]', ${at}, ${at})
  `;
  yield* sql`
    INSERT INTO projection_threads (thread_id, project_id, title, runtime_mode, interaction_mode, created_at, updated_at)
    VALUES (${threadId}, 'project:v1-history', 'V1 history', 'full-access', 'default', ${at}, ${at})
  `;
  yield* sql`
    INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, attachments_json, is_streaming, created_at, updated_at)
    VALUES ('message:v1-history', ${threadId}, 'turn:1', 'assistant', 'Historical answer', '[]', 0, ${at}, ${at})
  `;
  yield* sql`
    INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence)
    VALUES
      ('activity:command', ${threadId}, 'turn:1', 'tool', 'tool.completed', 'Recorded command',
        '{"itemType":"command_execution","toolCallId":"call:1","status":"completed","data":{"item":{"command":"cat synthetic.txt","aggregatedOutput":"Recorded output","exitCode":0}}}',
        ${at}, 1),
      ('activity:usage', ${threadId}, 'turn:1', 'info', 'turn.usage', 'Recorded usage',
        '{"usageScope":"main_agent","usageStatus":"complete","hasSubagents":false,"inputTokens":120,"outputTokens":30,"costUsd":0.002,"thread":{"inputTokens":120,"outputTokens":30}}',
        ${at}, 2)
  `;
  yield* sql`
    INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, completed_at, assistant_message_id,
      checkpoint_turn_count, checkpoint_ref, checkpoint_status, checkpoint_files_json)
    VALUES (${threadId}, 'turn:1', 'completed', ${at}, ${at}, 'message:v1-history',
      1, 'refs/styal/checkpoints/v1-history', 'ready', '[{"path":"synthetic.txt","kind":"modified","additions":2,"deletions":1}]')
  `;
});

const readSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly type: string;
    readonly name: string;
    readonly tbl_name: string;
  }>`
    SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name
  `;
  return {
    tables: new Set(rows.filter((row) => row.type === "table").map((row) => row.name)),
    indexedTables: new Set(rows.filter((row) => row.type === "index").map((row) => row.tbl_name)),
  };
});

const assertForkHistorySchema = Effect.gen(function* () {
  const { tables, indexedTables } = yield* readSchema;
  for (const dropped of ["projection_thread_activities", "projection_turns"]) {
    assert.isFalse(tables.has(dropped), dropped);
  }
  for (const kept of ["styal_legacy_v1_thread_activities", "styal_legacy_v1_turns"]) {
    assert.isTrue(tables.has(kept), kept);
  }
  // The importer reads activities by thread.
  assert.isTrue(indexedTables.has("styal_legacy_v1_thread_activities"));
});

const layerUpgradedDatabase = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: UPSTREAM_DROP_ID - 1 });
    yield* seedV1Thread;
    yield* runAllMigrations();
  }),
).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));
const layerStores = Layer.mergeAll(
  layerUpgradedDatabase,
  EventStore.layer.pipe(Layer.provideMerge(layerUpgradedDatabase)),
  ProjectionStore.layer.pipe(Layer.provideMerge(layerUpgradedDatabase)),
);
const layerEventSink = EventSink.layer.pipe(Layer.provide(layerStores));
const layerUpgrade = Layer.mergeAll(
  layerStores,
  layerEventSink,
  LegacyV1ThreadImporter.layer.pipe(Layer.provide(Layer.mergeAll(layerStores, layerEventSink))),
);

it.layer(layerUpgrade)("V1 history across upstream's V1 projection drop", (it) => {
  it.effect("keeps a V1 thread's tool history, usage and checkpoints importable", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* assertForkHistorySchema;
      assert.deepEqual(
        yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE migration_id = ${UPSTREAM_DROP_ID}`,
        [{ migration_id: UPSTREAM_DROP_ID }],
      );
      assert.deepEqual(
        yield* sql`SELECT activity_id FROM styal_legacy_v1_thread_activities ORDER BY sequence`,
        [{ activity_id: "activity:command" }, { activity_id: "activity:usage" }],
      );
      assert.deepEqual(yield* sql`SELECT turn_id FROM styal_legacy_v1_turns`, [
        { turn_id: "turn:1" },
      ]);
      assert.deepEqual(
        yield* sql`SELECT token_usage_json FROM projection_threads WHERE thread_id = ${threadId}`,
        [{ token_usage_json: '{"inputTokens":120,"outputTokens":30}' }],
      );

      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      yield* importer.reconcileShells;
      yield* importer.ensureTranscript(threadId);
      const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
        threadId,
      );
      const command = projection.turnItems.find((item) => item.type === "command_execution");
      assert.equal(command?.type === "command_execution" && command.input, "cat synthetic.txt");
      assert.equal(command?.type === "command_execution" && command.output, "Recorded output");
      assert.equal(projection.legacyTurnUsage?.records[0]?.usage?.costUsd, 0.002);
      assert.equal(projection.legacyTurnUsage?.thread.inputTokens, 120);
      assert.equal(projection.checkpoints[0]?.ref, "refs/styal/checkpoints/v1-history");
      assert.equal(projection.checkpoints[0]?.legacyCheckpointTurnCount, 1);
      assert.deepEqual(projection.checkpoints[0]?.files, [
        { path: "synthetic.txt", kind: "modified", additions: 2, deletions: 1 },
      ]);

      const again = yield* runAllMigrations();
      assert.deepEqual([again.upstream, again.fork], [[], []]);
      yield* assertForkHistorySchema;
      assert.equal(
        (yield* sql`SELECT activity_id FROM styal_legacy_v1_thread_activities`).length,
        2,
      );
    }),
  );
});

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("V1 history on a new database", (it) => {
  it.effect("creates the fork history tables and runs every migration once", () =>
    Effect.gen(function* () {
      const first = yield* runAllMigrations();
      assert.isAbove(first.fork.length, 0);
      yield* assertForkHistorySchema;
      const again = yield* runAllMigrations();
      assert.deepEqual([again.upstream, again.fork], [[], []]);
      yield* assertForkHistorySchema;
    }),
  );
});

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "V1 history after another build dropped it",
  (it) => {
    it.effect("creates empty fork history tables so fork migrations and readers still run", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* runAllMigrations();
        yield* assertForkHistorySchema;
        assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM styal_legacy_v1_turns`, [
          { count: 0 },
        ]);
      }),
    );
  },
);
