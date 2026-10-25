// @effect-diagnostics nodeBuiltinImport:off
// Byte-preserving JSON edits require checking the encoded representation as well as decoded values.
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { runAllMigrations } from "../../persistence/ForkMigrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { orderLegacyHistory } from "./orderLegacyHistory.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

// As imported: messages first, then the activity that happened between them, then a run.
const items = [
  { id: "user", runId: null, ordinal: 1, startedAt: "2026-01-01T00:00:00.000Z" },
  { id: "answer", runId: null, ordinal: 2, startedAt: "2026-01-01T00:00:30.000Z" },
  { id: "command", runId: null, ordinal: 3, startedAt: "2026-01-01T00:00:10.000Z" },
  { id: "edit", runId: null, ordinal: 4, startedAt: "2026-01-01T00:00:20.000Z" },
  { id: "native", runId: "run-1", ordinal: 1_000_001, startedAt: "2026-01-01T00:00:05.000Z" },
];

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("orderLegacyHistory", (it) => {
  it.effect("orders imported history by time in positions, projection and events", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runAllMigrations();
      for (const [index, item] of items.entries()) {
        const payload = yield* encodeJson({
          id: item.id,
          ordinal: item.ordinal,
          startedAt: item.startedAt,
        });
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items
            (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
          VALUES (${item.id}, 'thread-1', ${item.runId}, ${item.ordinal}, 'system_notice', 'completed',
            ${item.startedAt}, ${payload})
        `;
        yield* sql`
          INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
          VALUES ('thread-1', ${item.id}, ${item.ordinal})
        `;
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            actor_kind, payload_json, metadata_json, application_event_version
          ) VALUES (
            ${`event-${item.id}`}, 'thread', 'thread-1', ${index}, 'turn-item.updated',
            ${item.startedAt}, 'server', ${JSON.stringify({ ...JSON.parse(payload), historical: true })}, '{}', 2
          )
        `;
      }

      yield* sql`
        INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
        VALUES ('unrelated-thread', 'unrelated-item', 42)
      `;
      assert.equal(yield* orderLegacyHistory(sql, ["thread-1"]), 3);
      assert.deepEqual(
        yield* sql`SELECT ordinal FROM orchestration_v2_turn_item_positions
          WHERE thread_id = 'unrelated-thread'`,
        [{ ordinal: 42 }],
      );

      const expected = [
        ["user", 1],
        ["command", 2],
        ["edit", 3],
        ["answer", 4],
        ["native", 1_000_001],
      ];
      const positions = yield* sql<{ readonly id: string; readonly ordinal: number }>`
        SELECT turn_item_id AS id, ordinal FROM orchestration_v2_turn_item_positions WHERE thread_id = 'thread-1' ORDER BY ordinal
      `;
      assert.deepEqual(
        positions.map((row) => [row.id, row.ordinal]),
        expected,
      );
      const projected = yield* sql<{ readonly payload_json: string; readonly ordinal: number }>`
        SELECT payload_json, ordinal FROM orchestration_v2_projection_turn_items ORDER BY ordinal
      `;
      const events = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_events
        ORDER BY json_extract(payload_json, '$.ordinal')
      `;
      for (const rows of [projected, events]) {
        const payloads = yield* Effect.forEach(rows, (row) => decodeJson(row.payload_json));
        assert.deepEqual(
          payloads.map((payload) => {
            const { id, ordinal } = payload as { readonly id: string; readonly ordinal: number };
            return [id, ordinal];
          }),
          expected,
        );
      }
      assert.ok(events.every((row) => JSON.parse(row.payload_json).historical === true));
      assert.ok(projected.every((row) => JSON.parse(row.payload_json).historical === undefined));
      // Already ordered history is left alone.
      assert.equal(yield* orderLegacyHistory(sql, ["thread-1"]), 0);
    }),
  );
});

it.effect("reorders large payloads without rewriting their unchanged overflow pages", () => {
  const scratch = new URL("../../../../../.scratch/", import.meta.url);
  NodeFS.mkdirSync(scratch, { recursive: true });
  const directory = NodeFS.mkdtempSync(
    NodeURL.fileURLToPath(new URL("server-update-order-wal-", scratch)),
  );
  const filename = `${directory}/state.sqlite`;
  const body = "x".repeat(4 * 1024 * 1024);
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA journal_mode = WAL`;
    yield* sql`PRAGMA wal_autocheckpoint = 0`;
    yield* runAllMigrations();
    const payload = JSON.stringify({
      id: "answer",
      ordinal: 100,
      body,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    yield* sql`
            INSERT INTO orchestration_v2_projection_turn_items
              (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
            VALUES ('answer', 'thread-1', NULL, 100, 'system_notice', 'completed',
              '2026-01-01T00:00:00.000Z', ${payload})
          `;
    yield* sql`
            INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
            VALUES ('thread-1', 'answer', 100)
          `;
    yield* sql`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
              actor_kind, payload_json, metadata_json, application_event_version
            ) VALUES ('event-answer', 'thread', 'thread-1', 1, 'turn-item.updated',
              '2026-01-01T00:00:00.000Z', 'server', ${payload}, '{}', 2)
          `;
    yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
    assert.equal(yield* sql.withTransaction(orderLegacyHistory(sql, ["thread-1"])), 1);
    assert.ok(NodeFS.statSync(`${filename}-wal`).size < 128 * 1024);
    const rows = yield* sql<{ readonly payload_json: string }>`
            SELECT payload_json FROM orchestration_v2_projection_turn_items
            UNION ALL SELECT payload_json FROM orchestration_events
          `;
    for (const row of rows) {
      assert.deepEqual(JSON.parse(row.payload_json), { ...JSON.parse(payload), ordinal: 1 });
      assert.ok(Buffer.byteLength(row.payload_json) >= Buffer.byteLength(payload));
    }
    const positions = yield* sql<{ readonly ordinal: number }>`
            SELECT ordinal FROM orchestration_v2_turn_item_positions WHERE turn_item_id = 'answer'
          `;
    assert.equal(positions[0]?.ordinal, 1);
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename })),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("paged history ordering", (it) => {
  it.effect("updates every page while preserving each event's own payload", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runAllMigrations();
      for (let index = 1; index <= 45; index++) {
        const id = `item-${index}`;
        const startedAt = `2026-01-01T00:00:${String(46 - index).padStart(2, "0")}.000Z`;
        const payload = yield* encodeJson({ id, ordinal: index, startedAt, body: "projection" });
        const eventPayload = yield* encodeJson({ id, ordinal: index, startedAt, body: "event" });
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items
            (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
          VALUES (${id}, 'paged-thread', ${index}, 'system_notice', 'completed', ${startedAt}, ${payload})
        `;
        yield* sql`
          INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
          VALUES ('paged-thread', ${id}, ${index})
        `;
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            actor_kind, payload_json, metadata_json, application_event_version
          ) VALUES (${id}, 'thread', 'paged-thread', ${index}, 'turn-item.updated',
            ${startedAt}, 'server', ${eventPayload}, '{}', 2)
        `;
      }
      assert.equal(yield* orderLegacyHistory(sql, ["paged-thread"]), 44);
      const projected = yield* sql<{ readonly payload_json: string; readonly ordinal: number }>`
        SELECT payload_json, ordinal FROM orchestration_v2_projection_turn_items ORDER BY ordinal
      `;
      const events = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_events ORDER BY sequence
      `;
      for (const [index, row] of projected.entries()) {
        const payload = JSON.parse(row.payload_json);
        assert.equal(row.ordinal, index + 1);
        assert.equal(payload.ordinal, index + 1);
        assert.equal(payload.id, `item-${45 - index}`);
        assert.equal(payload.body, "projection");
      }
      for (const [index, row] of events.entries()) {
        const payload = JSON.parse(row.payload_json);
        assert.equal(payload.ordinal, 45 - index);
        assert.equal(payload.body, "event");
      }
      assert.equal(yield* orderLegacyHistory(sql, ["paged-thread"]), 0);
    }),
  );
});
