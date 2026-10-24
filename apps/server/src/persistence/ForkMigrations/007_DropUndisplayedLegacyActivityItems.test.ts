import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { runAllMigrations, runForkMigrations } from "../ForkMigrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const at = "2026-01-01T00:00:00.000Z";
const items = [
  // Bookkeeping notices and bare tool starts go.
  {
    id: "import:v1:activity:thread-1:usage",
    type: "system_notice",
    status: "completed",
    kinds: ["turn.usage"],
  },
  {
    id: "import:v1:activity:thread-1:start",
    type: "command_execution",
    status: "interrupted",
    kinds: ["tool.started"],
  },
  // Anything holding a displayed kind stays, as do items the importer did not write.
  {
    id: "import:v1:activity:thread-1:running",
    type: "command_execution",
    status: "interrupted",
    kinds: ["tool.started", "tool.updated"],
  },
  {
    id: "import:v1:activity:thread-1:task",
    type: "system_notice",
    status: "completed",
    kinds: ["task.completed"],
  },
  {
    id: "native-notice",
    type: "system_notice",
    status: "completed",
    kinds: ["context-window.updated"],
  },
];
// Each importer writes item events under its own prefix.
const eventId = (itemId: string, index: number) =>
  `${index % 2 === 0 ? "migration:v1:history:thread-1" : "import:v1:source-event"}:item:${itemId}`;

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "007_DropUndisplayedLegacyActivityItems",
  (it) => {
    it.effect("removes imported items made only of undisplayed activity kinds", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runAllMigrations({ forkToMigrationInclusive: 6 });

        for (const [index, item] of items.entries()) {
          const payload = yield* encodeJson({
            id: item.id,
            type: item.type,
            legacyActivities: item.kinds.map((kind) => ({ kind })),
          });
          yield* sql`
            INSERT INTO orchestration_v2_projection_turn_items
              (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
            VALUES (${item.id}, 'thread-1', ${index}, ${item.type}, ${item.status}, ${at}, ${payload})
          `;
          yield* sql`
            INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
            VALUES ('thread-1', ${item.id}, ${index})
          `;
          yield* sql`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
              actor_kind, payload_json, metadata_json, application_event_version
            ) VALUES (
              ${item.id === "native-notice" ? "native-event" : eventId(item.id, index)},
              'thread', 'thread-1', ${index}, 'turn-item.updated', ${at}, 'server', ${payload}, '{}', 2
            )
          `;
        }

        yield* runForkMigrations({ toMigrationInclusive: 7 });

        const kept = [
          "import:v1:activity:thread-1:running",
          "import:v1:activity:thread-1:task",
          "native-notice",
        ];
        const projected = yield* sql<{ readonly id: string }>`
          SELECT turn_item_id AS id FROM orchestration_v2_projection_turn_items ORDER BY ordinal
        `;
        assert.deepEqual(
          projected.map((row) => row.id),
          kept,
        );
        const positioned = yield* sql<{ readonly id: string }>`
          SELECT turn_item_id AS id FROM orchestration_v2_turn_item_positions ORDER BY ordinal
        `;
        assert.deepEqual(
          positioned.map((row) => row.id),
          kept,
        );
        const events = yield* sql<{ readonly id: string }>`
          SELECT json_extract(payload_json, '$.id') AS id FROM orchestration_events
          ORDER BY stream_version
        `;
        assert.deepEqual(
          events.map((row) => row.id),
          kept,
        );
      }),
    );
  },
);
