import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { runAllMigrations } from "../../persistence/ForkMigrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { readHistoryRewriteFence } from "../historyRewriteFence.ts";
import { slimImportedHistory } from "./slimImportedHistory.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const at = "2026-01-01T00:00:00.000Z";

const activity = (id: string, kind: string, payload: unknown) => ({
  id,
  tone: "tool",
  kind,
  summary: "Ran command",
  payload,
  turnId: null,
  createdAt: at,
});
const items = [
  // Output recorded only in the V1 payload, in a shape the converter used to miss.
  {
    id: "import:v1:activity:thread-1:folded",
    type: "command_execution",
    input: "vp test",
    legacyActivities: [
      activity("folded-start", "tool.started", {
        itemType: "command_execution",
        status: "inProgress",
      }),
      activity("folded-end", "tool.completed", {
        itemType: "command_execution",
        status: "completed",
        data: { state: { output: "3 passed", metadata: { exitCode: 0 } } },
      }),
    ],
  },
  // Canonical output already present stays as it is.
  {
    id: "import:v1:activity:thread-1:kept",
    type: "command_execution",
    input: "ls",
    output: "canonical",
    exitCode: 2,
    legacyActivities: [
      activity("kept-end", "tool.completed", { data: { item: { aggregatedOutput: "other" } } }),
    ],
  },
  {
    id: "import:v1:activity:thread-1:tool",
    type: "dynamic_tool",
    input: { query: "x" },
    legacyActivities: [
      activity("tool-end", "tool.completed", { data: { large: "y".repeat(500) } }),
    ],
  },
];

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("slimImportedHistory", (it) => {
  it.effect("folds recorded command output into items and keeps only activity references", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runAllMigrations();
      for (const [index, item] of items.entries()) {
        const payload = yield* encodeJson(item);
        yield* sql`
            INSERT INTO orchestration_v2_projection_turn_items
              (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
            VALUES (${item.id}, 'thread-1', ${index + 1}, ${item.type}, 'completed', ${at}, ${payload})
          `;
        yield* sql`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
              actor_kind, payload_json, metadata_json, application_event_version
            ) VALUES (
              ${`migration:v1:history:thread-1:item:${item.id}`}, 'thread', 'thread-1', ${index + 1},
              'turn-item.updated', ${at}, 'server', ${payload}, '{}', 2
            )
          `;
      }
      const fenceBefore = yield* readHistoryRewriteFence(sql);

      assert.deepEqual(yield* slimImportedHistory(sql), { threads: 1, rows: items.length * 2 });
      const fenceAfter = yield* readHistoryRewriteFence(sql);
      // Later startups find the pass recorded as done.
      assert.deepEqual(yield* slimImportedHistory(sql), { threads: 0, rows: 0 });
      assert.equal(yield* readHistoryRewriteFence(sql), fenceAfter);

      const projected = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_turn_items ORDER BY ordinal
        `;
      const events = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_events ORDER BY stream_version
        `;
      assert.deepEqual(
        events.map((row) => row.payload_json),
        projected.map((row) => row.payload_json),
      );
      const [folded, kept, tool] = (yield* Effect.forEach(projected, (row) =>
        decodeJson(row.payload_json),
      )) as ReadonlyArray<{
        readonly output?: string;
        readonly exitCode?: number;
        readonly legacyActivities: ReadonlyArray<Record<string, unknown>>;
      }>;
      assert.deepEqual([folded?.output, folded?.exitCode], ["3 passed", 0]);
      assert.deepEqual([kept?.output, kept?.exitCode], ["canonical", 2]);
      assert.notProperty(tool, "output");
      assert.deepEqual(
        [folded, kept, tool].flatMap((item) =>
          (item?.legacyActivities ?? []).map((reference) => [reference.id, "payload" in reference]),
        ),
        [
          ["folded-start", false],
          ["folded-end", false],
          ["kept-end", false],
          ["tool-end", false],
        ],
      );
      assert.isAbove(yield* readHistoryRewriteFence(sql), Math.max(fenceBefore, items.length));
    }),
  );
});
