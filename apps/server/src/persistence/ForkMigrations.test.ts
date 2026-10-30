import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  forkMigrationEntries,
  forkMigrationManifest,
  runAllMigrations,
  runForkMigrations,
} from "./ForkMigrations.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const upstreamLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

upstreamLayer("ForkMigrations canonical upstream upgrade", (it) => {
  it.effect("leaves canonical upstream migration 39 untouched", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      yield* runAllMigrations();

      const upstreamMigration = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id = 39
      `;
      assert.deepStrictEqual(upstreamMigration, [
        {
          migration_id: 39,
          name: "ProjectionProjectsDefaultThreadEnvMode",
        },
      ]);

      const forkHistory = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM yngatech_sql_migrations
      `;
      assert.deepStrictEqual(forkHistory, [
        { migration_id: 1, name: "ComposerDrafts" },
        { migration_id: 2, name: "WorkspacePortAllocations" },
        { migration_id: 3, name: "ProjectAdditionalInstructions" },
        { migration_id: 4, name: "ProjectionThreadLatestMessageAt" },
        { migration_id: 5, name: "ProjectionThreadTokenUsage" },
        { migration_id: 6, name: "LegacyTurnUsage" },
        { migration_id: 7, name: "DropUndisplayedLegacyActivityItems" },
        { migration_id: 8, name: "HistoryRewriteFence" },
        { migration_id: 9, name: "RederiveLegacyActivityItems" },
        { migration_id: 10, name: "HardwareLeases" },
        { migration_id: 11, name: "ProjectionProjectsOrganization" },
        { migration_id: 12, name: "DropComposerDrafts" },
      ]);
    }),
  );
});

it("keeps fork migration IDs sequential from 1", () => {
  assert.deepStrictEqual(
    forkMigrationEntries.map(([id]) => id),
    forkMigrationEntries.map((_, index) => index + 1),
  );
});

it("keeps fork migrations out of the upstream manifest", () => {
  assert.notInclude(
    migrationManifest.map(([, name]) => name as string),
    "ComposerDrafts",
  );
  assert.notInclude(
    migrationManifest.map(([, name]) => name as string),
    "WorkspacePortAllocations",
  );
  assert.notInclude(
    migrationManifest.map(([, name]) => name as string),
    "ProjectionThreadLatestMessageAt",
  );
  assert.deepStrictEqual(forkMigrationManifest, [
    [1, "ComposerDrafts"],
    [2, "WorkspacePortAllocations"],
    [3, "ProjectAdditionalInstructions"],
    [4, "ProjectionThreadLatestMessageAt"],
    [5, "ProjectionThreadTokenUsage"],
    [6, "LegacyTurnUsage"],
    [7, "DropUndisplayedLegacyActivityItems"],
    [8, "HistoryRewriteFence"],
    [9, "RederiveLegacyActivityItems"],
    [10, "HardwareLeases"],
    [11, "ProjectionProjectsOrganization"],
    [12, "DropComposerDrafts"],
  ]);
});

const insertSyntheticThread = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      created_at, updated_at
    ) VALUES (
      'thread-1', 'project-1', 'Synthetic thread',
      '{"instanceId":"codex","model":"gpt-5"}', 'full-access',
      '2026-01-01T10:00:00.000Z', '2026-01-01T10:30:00.000Z'
    )
  `;
  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, role, text, is_streaming, created_at, updated_at
    ) VALUES
      ('user-1', 'thread-1', 'user', 'Prompt', 0,
        '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z'),
      ('assistant-1', 'thread-1', 'assistant', 'Reply', 0,
        '2026-01-01T10:10:00.000Z', '2026-01-01T10:13:00.000Z')
  `;
});

const readLatestMessageAt = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly latestMessageAt: string | null }>`
    SELECT latest_message_at AS "latestMessageAt"
    FROM projection_threads
    WHERE thread_id = 'thread-1'
  `;
});

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "ForkMigrations recorded token history upgrade",
  (it) => {
    it.effect("upgrades a database with migration 5 without losing frozen usage", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runAllMigrations({ forkToMigrationInclusive: 4 });
        yield* insertSyntheticThread;
        const threadUsage = { inputTokens: 321, outputTokens: 123, totalCostUsd: 0.012345 };
        const activityUsage = yield* encodeJson({ thread: threadUsage });
        yield* sql`INSERT INTO styal_legacy_v1_thread_activities
          (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
          VALUES ('usage-1', 'thread-1', 'info', 'turn.usage', 'Recorded usage',
            ${activityUsage}, '2026-01-01T10:13:00.000Z')`;
        yield* runForkMigrations({ toMigrationInclusive: 5 });

        const frozenHistory = yield* encodeJson({
          turns: [{ turnId: "turn-1", thread: threadUsage }],
        });
        const executed = yield* runForkMigrations({ toMigrationInclusive: 6 });
        assert.deepEqual(
          executed.map(([id, name]) => [id, name]),
          [[6, "LegacyTurnUsage"]],
        );
        yield* sql`INSERT INTO styal_projection_legacy_turn_usage (thread_id, payload_json)
          VALUES ('thread-1', ${frozenHistory})`;
        assert.deepEqual(yield* runForkMigrations({ toMigrationInclusive: 6 }), []);

        const totals = yield* sql<{ readonly token_usage_json: string }>`
          SELECT token_usage_json FROM projection_threads WHERE thread_id = 'thread-1'
        `;
        assert.deepEqual(yield* decodeJson(totals[0]?.token_usage_json ?? "null"), threadUsage);
        const history = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM styal_projection_legacy_turn_usage WHERE thread_id = 'thread-1'
        `;
        assert.deepEqual(history, [{ payload_json: frozenHistory }]);
      }),
    );
  },
);

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "ForkMigrations latest message time",
  (it) => {
    it.effect("backfills the last message time without using later thread updates", () =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* runForkMigrations({ toMigrationInclusive: 3 });
        yield* insertSyntheticThread;

        yield* runForkMigrations({ toMigrationInclusive: 4 });

        assert.deepEqual(yield* readLatestMessageAt, [
          { latestMessageAt: "2026-01-01T10:13:00.000Z" },
        ]);
      }),
    );
  },
);

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "ForkMigrations misplaced upstream record",
  (it) => {
    it.effect("moves a nightly's upstream 51 record into the fork history", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // A nightly from 2026-09-29 ran this migration as upstream 51.
        yield* runMigrations({ toMigrationInclusive: 50 });
        yield* runForkMigrations({ toMigrationInclusive: 3 });
        yield* insertSyntheticThread;
        yield* sql`ALTER TABLE projection_threads ADD COLUMN latest_message_at TEXT`;
        yield* sql`UPDATE projection_threads SET latest_message_at = '2026-01-01T10:20:00.000Z'`;
        yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (51, 'ProjectionThreadLatestMessageAt')
      `;

        yield* runAllMigrations();

        const upstreamRecord = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id = 51
      `;
        assert.notDeepInclude(upstreamRecord, { name: "ProjectionThreadLatestMessageAt" });
        const forkRecord = yield* sql<{ readonly name: string }>`
        SELECT name FROM yngatech_sql_migrations WHERE migration_id = 4
      `;
        assert.deepEqual(forkRecord, [{ name: "ProjectionThreadLatestMessageAt" }]);
        // The column is kept as it was; the fork migration does not backfill it again.
        assert.deepEqual(yield* readLatestMessageAt, [
          { latestMessageAt: "2026-01-01T10:20:00.000Z" },
        ]);
      }),
    );
  },
);
