import * as NodeUtil from "node:util";
import { OrchestrationV2TurnItemJson } from "@t3tools/contracts";
import { OrchestrationThreadActivity } from "@t3tools/contracts/legacy-orchestration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import { legacyActivityTurnItem } from "./LegacyHistoricalItems.ts";
import { preserveLegacyPayloadSize } from "./legacyPayloadEncoding.ts";

const DONE_MARKER = "legacy-tool-items-rederived";
const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));
const decodeActivity = Schema.decodeUnknownEffect(OrchestrationThreadActivity);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const storedJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeStored = Schema.decodeUnknownEffect(storedJson);
const encodeStored = Schema.encodeEffect(storedJson);
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

/** Repair earlier imports in background transactions; the retained V1 rows remain authoritative. */
export const rederiveLegacyToolItems = Effect.fn("rederiveLegacyToolItems")(function* (
  sql: SqlClient.SqlClient,
) {
  const done = yield* sql<{ readonly updated_at: string }>`
    SELECT updated_at FROM orchestration_v2_projection_metadata WHERE projection_name = ${DONE_MARKER}
  `;
  const now = yield* DateTime.now;
  if (done[0] !== undefined) {
    if (
      DateTime.toEpochMillis(now) -
        DateTime.toEpochMillis(DateTime.makeUnsafe(done[0].updated_at)) >=
      30 * 24 * 60 * 60 * 1000
    ) {
      const undo =
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'styal_legacy_v1_rederived_items'`;
      if (undo.length > 0) {
        yield* sql`DROP TABLE styal_legacy_v1_rederived_items`;
        yield* Effect.logInfo("Dropped the undo copy of re-derived imported v1 tool items");
      }
    }
    return { threads: 0, items: 0 };
  }
  yield* sql`CREATE TABLE IF NOT EXISTS styal_legacy_v1_rederived_items (
    turn_item_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
    previous_payload_json TEXT NOT NULL, rederived_at TEXT NOT NULL
  )`;
  const threads = yield* sql<{ readonly thread_id: string }>`
    SELECT DISTINCT thread_id FROM orchestration_v2_projection_turn_items
    WHERE turn_item_id LIKE 'import:v1:activity:%' AND run_id IS NULL
      AND type IN ('command_execution', 'dynamic_tool') ORDER BY thread_id
  `;
  let items = 0;
  for (const { thread_id: threadId } of threads) {
    items += yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId} AND turn_item_id LIKE 'import:v1:activity:%'
          AND run_id IS NULL AND type IN ('command_execution', 'dynamic_tool')
      `;
        let changed = 0;
        for (const row of rows) {
          // An unreadable row stays as it is rather than stopping every later startup's pass.
          const decoded = yield* decodeItem(row.payload_json).pipe(Effect.option);
          if (decoded._tag === "None") continue;
          const item = decoded.value;
          if (!item.legacyActivities?.length) continue;
          const activities = [];
          for (const reference of item.legacyActivities) {
            const source = yield* sql<{
              readonly activity_id: string;
              readonly tone: string;
              readonly kind: string;
              readonly summary: string;
              readonly payload_json: string;
              readonly turn_id: string | null;
              readonly sequence: number | null;
              readonly created_at: string;
            }>`SELECT activity_id, tone, kind, summary, payload_json, turn_id, sequence, created_at
            FROM styal_legacy_v1_thread_activities WHERE activity_id = ${reference.id} AND thread_id = ${threadId}`;
            const activity = source[0];
            if (activity === undefined) break;
            const payload = decodeJson(activity.payload_json);
            const decodedActivity = yield* decodeActivity({
              id: activity.activity_id,
              tone: activity.tone,
              kind: activity.kind,
              summary: activity.summary,
              payload: payload._tag === "Some" ? payload.value : undefined,
              turnId: activity.turn_id,
              createdAt: activity.created_at,
              ...(activity.sequence === null ? {} : { sequence: activity.sequence }),
            }).pipe(Effect.option);
            if (decodedActivity._tag === "None") break;
            activities.push(decodedActivity.value);
          }
          if (activities.length !== item.legacyActivities.length) continue;
          const rederived = legacyActivityTurnItem(
            { id: item.id, threadId: item.threadId, ordinal: item.ordinal },
            activities,
          );
          if (rederived === null || rederived.type !== item.type) continue;
          const ordered = activities.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
          const terminal =
            ordered.findLast((activity) => activity.kind === "tool.completed") ?? ordered.at(-1);
          const payload = isRecord(terminal?.payload) ? terminal.payload : {};
          const patch: Record<string, unknown> = {};
          if (item.type === "command_execution" && rederived.type === "command_execution") {
            if (item.output === undefined && rederived.output !== undefined)
              patch.output = rederived.output;
            if (item.exitCode === undefined && rederived.exitCode !== undefined)
              patch.exitCode = rederived.exitCode;
            if (item.input === payload.detail && rederived.input !== item.input)
              patch.input = rederived.input;
          } else if (item.type === "dynamic_tool" && rederived.type === "dynamic_tool") {
            if (
              (item.toolName == null || item.toolName === item.title) &&
              rederived.toolName?.trim() &&
              rederived.toolName !== item.toolName
            )
              patch.toolName = rederived.toolName;
            if (
              (item.input === undefined || NodeUtil.isDeepStrictEqual(item.input, payload.data)) &&
              rederived.input !== undefined &&
              !NodeUtil.isDeepStrictEqual(item.input, rederived.input)
            )
              patch.input = rederived.input;
            if (item.output === undefined && rederived.output !== undefined)
              patch.output = rederived.output;
          }
          if (Object.keys(patch).length === 0) continue;
          // Merge into the stored JSON so unrelated fields and activity references stay intact.
          const stored = yield* decodeStored(row.payload_json);
          const json = preserveLegacyPayloadSize(
            row.payload_json,
            yield* encodeStored({ ...stored, ...patch }),
          );
          const rederivedAt = DateTime.formatIso(yield* DateTime.now);
          yield* sql`INSERT INTO styal_legacy_v1_rederived_items (turn_item_id, thread_id, previous_payload_json, rederived_at)
          VALUES (${item.id}, ${threadId}, ${row.payload_json}, ${rederivedAt}) ON CONFLICT DO NOTHING`;
          yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = ${json} WHERE turn_item_id = ${item.id}`;
          yield* sql`UPDATE orchestration_events INDEXED BY idx_orchestration_events_agent_stream_sequence
          SET payload_json = ${json}
          WHERE application_event_version = 2 AND aggregate_kind = 'thread' AND stream_id = ${threadId}
            AND event_type = 'turn-item.updated' AND instr(event_id, ${`:item:${item.id}`}) > 0`;
          changed++;
        }
        return changed;
      }),
    );
    yield* Effect.yieldNow;
  }
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const finishedAt = DateTime.formatIso(yield* DateTime.now);
      // Count earlier interrupted runs too, so their changes also reach cached clients.
      const rederived = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM styal_legacy_v1_rederived_items`;
      if ((rederived[0]?.count ?? 0) > 0) {
        yield* sql`UPDATE sqlite_sequence
        SET seq = MAX(seq, (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events)) + 1
        WHERE name = 'orchestration_events'`;
        yield* sql`INSERT INTO orchestration_v2_projection_metadata (projection_name, schema_version, last_sequence, updated_at)
        VALUES ('history-rewrite-fence', 1, (SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'), ${finishedAt})
        ON CONFLICT(projection_name) DO UPDATE SET last_sequence = excluded.last_sequence, updated_at = excluded.updated_at`;
      }
      yield* sql`INSERT INTO orchestration_v2_projection_metadata (projection_name, schema_version, last_sequence, updated_at)
      VALUES (${DONE_MARKER}, 1, 0, ${finishedAt}) ON CONFLICT(projection_name) DO NOTHING`;
    }),
  );
  const result = { threads: threads.length, items };
  if (items > 0) yield* Effect.logInfo("Re-derived imported v1 tool items", result);
  return result;
});
