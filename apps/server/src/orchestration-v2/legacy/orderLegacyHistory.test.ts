import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
            ${item.startedAt}, 'server', ${payload}, '{}', 2
          )
        `;
      }

      assert.equal(yield* orderLegacyHistory(sql, ["thread-1"]), 3);

      const expected = [
        ["user", 1],
        ["command", 2],
        ["edit", 3],
        ["answer", 4],
        ["native", 1_000_001],
      ];
      const positions = yield* sql<{ readonly id: string; readonly ordinal: number }>`
        SELECT turn_item_id AS id, ordinal FROM orchestration_v2_turn_item_positions ORDER BY ordinal
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
      // Already ordered history is left alone.
      assert.equal(yield* orderLegacyHistory(sql, ["thread-1"]), 0);
    }),
  );
});
