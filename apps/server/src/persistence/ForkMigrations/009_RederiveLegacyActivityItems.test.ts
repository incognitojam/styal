import { assert, it } from "@effect/vitest";
import {
  EventId,
  OrchestrationV2TurnItemJson,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { readHistoryRewriteFence } from "../../orchestration-v2/historyRewriteFence.ts";
import { runForkMigrations } from "../ForkMigrations.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const encodeItem = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));
const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));
const threadId = ThreadId.make("thread-1");
const at = "2026-01-01T00:00:00.000Z";

type LegacyActivity = NonNullable<OrchestrationV2TurnItem["legacyActivities"]>[number];
const activity = (
  id: string,
  kind: string,
  payload: Record<string, unknown>,
  tone: LegacyActivity["tone"] = "info",
): LegacyActivity => ({
  id: EventId.make(id),
  tone,
  kind,
  summary: kind,
  payload,
  turnId: null,
  createdAt: at,
});

// Items as an earlier import stored them: everything non-tool became a warning notice, and a
// late in-progress update outranked the tool's completion.
const notice = (
  key: string,
  ordinal: number,
  activities: ReadonlyArray<LegacyActivity>,
): OrchestrationV2TurnItem => ({
  id: TurnItemId.make(`import:v1:activity:${threadId}:${key}`),
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed",
  title: activities[0]?.summary ?? null,
  startedAt: DateTime.makeUnsafe(at),
  completedAt: DateTime.makeUnsafe(at),
  updatedAt: DateTime.makeUnsafe(at),
  legacyActivities: activities,
  type: "system_notice",
  message: activities[0]?.summary ?? "",
});
const items: ReadonlyArray<OrchestrationV2TurnItem> = [
  notice("task", 1, [
    activity("task", "task.completed", { title: "Run tests", taskType: "local_bash" }),
  ]),
  notice("chatter", 2, [
    activity("chatter", "task.progress", { title: "explorer", timelineBypass: true }),
  ]),
  notice("warning", 3, [activity("warning", "runtime.warning", {})]),
  {
    ...notice("tool", 4, [
      activity(
        "tool-done",
        "tool.completed",
        { itemType: "mcp_tool_call", status: "completed" },
        "tool",
      ),
      activity(
        "tool-late",
        "tool.updated",
        { itemType: "mcp_tool_call", status: "inProgress" },
        "tool",
      ),
    ]),
    status: "interrupted",
    type: "dynamic_tool",
    toolName: null,
    input: {},
  } as OrchestrationV2TurnItem,
];

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "009_RederiveLegacyActivityItems",
  (it) => {
    it.effect("re-derives imported items in their events and projection", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* runForkMigrations({ toMigrationInclusive: 8 });
        for (const item of items) {
          const payload = yield* encodeItem(item);
          yield* sql`
            INSERT INTO orchestration_v2_projection_turn_items
              (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
            VALUES (${item.id}, ${threadId}, ${item.ordinal}, ${item.type}, ${item.status}, ${at}, ${payload})
          `;
          yield* sql`
            INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
            VALUES (${threadId}, ${item.id}, ${item.ordinal})
          `;
          yield* sql`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
              actor_kind, payload_json, metadata_json, application_event_version
            ) VALUES (
              ${`migration:v1:history:${threadId}:item:${item.id}`}, 'thread', ${threadId},
              ${item.ordinal}, 'turn-item.updated', ${at}, 'server', ${payload}, '{}', 2
            )
          `;
        }

        const fenceBefore = yield* readHistoryRewriteFence(sql);
        yield* runForkMigrations();
        // Rewritten history moves the fence past every stored event.
        assert.isAbove(yield* readHistoryRewriteFence(sql), Math.max(fenceBefore, items.length));

        const projected = yield* sql<{
          readonly type: string;
          readonly status: string;
          readonly payload_json: string;
        }>`SELECT type, status, payload_json FROM orchestration_v2_projection_turn_items ORDER BY ordinal`;
        const events = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_events ORDER BY stream_version
        `;
        // Event and projection keep the same stored item.
        assert.deepEqual(
          events.map((row) => row.payload_json),
          projected.map((row) => row.payload_json),
        );
        const positions = yield* sql<{ readonly ordinal: number }>`
          SELECT ordinal FROM orchestration_v2_turn_item_positions ORDER BY ordinal
        `;
        assert.deepEqual(
          positions.map((row) => row.ordinal),
          [1, 3, 4],
        );
        assert.deepEqual(
          projected.map((row) => [row.type, row.status]),
          [
            ["notification", "completed"],
            ["system_notice", "completed"],
            ["dynamic_tool", "completed"],
          ],
        );
        const task = yield* decodeItem(projected[0]!.payload_json);
        assert.deepEqual(
          task.type === "notification" && [task.source, task.outcome, task.summary],
          [{ kind: "command" }, "completed", "Run tests"],
        );
      }),
    );
  },
);
