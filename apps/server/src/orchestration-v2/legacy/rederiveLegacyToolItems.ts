import * as NodeUtil from "node:util";
import { OrchestrationV2TurnItemJson } from "@t3tools/contracts";
import { OrchestrationThreadActivity } from "@t3tools/contracts/legacy-orchestration";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import { legacyActivityTurnItem } from "./LegacyHistoricalItems.ts";

const DONE_MARKER = "legacy-tool-items-rederived";
// Set with each change and cleared once the fence moves, so a pass that stops early still moves it.
const FENCE_PENDING = "legacy-tool-items-fence-pending";
const ITEM_EVENT_MARKER = ":item:import:v1:activity:";
const BATCH_SIZE = 100;
const BATCH_BUDGET_MS = 250;
const BATCH_BYTES = 1024 * 1024;
const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));
const decodeActivity = Schema.decodeUnknownEffect(OrchestrationThreadActivity);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const storedJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeStored = Schema.decodeUnknownEffect(storedJson);
const encodeStored = Schema.encodeEffect(storedJson);
const encodeFieldNames = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
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
    return { threads: 0, items: 0, failed: 0 };
  }
  const threads = yield* sql<{ readonly thread_id: string }>`
    SELECT DISTINCT thread_id FROM orchestration_v2_projection_turn_items
    WHERE turn_item_id LIKE 'import:v1:activity:%' AND run_id IS NULL
      AND type IN ('command_execution', 'dynamic_tool') ORDER BY thread_id
  `;
  let items = 0;
  let failed = 0;
  for (const { thread_id: threadId } of threads) {
    const rows = yield* sql<{ readonly turn_item_id: string }>`
      SELECT turn_item_id FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${threadId} AND turn_item_id LIKE 'import:v1:activity:%'
        AND run_id IS NULL AND type IN ('command_execution', 'dynamic_tool')
      ORDER BY turn_item_id
    `;
    // One stream scan per thread; matching each item's event separately is quadratic.
    const eventRows = yield* sql<{ readonly sequence: number; readonly item_id: string }>`
      SELECT sequence, substr(event_id, instr(event_id, ${ITEM_EVENT_MARKER}) + 6) AS item_id
      FROM orchestration_events INDEXED BY idx_orchestration_events_agent_stream_sequence
      WHERE application_event_version = 2 AND aggregate_kind = 'thread' AND stream_id = ${threadId}
        AND event_type = 'turn-item.updated' AND instr(event_id, ${ITEM_EVENT_MARKER}) > 0
    `;
    const eventSequences = new Map<string, number[]>();
    for (const event of eventRows) {
      eventSequences.set(event.item_id, [
        ...(eventSequences.get(event.item_id) ?? []),
        event.sequence,
      ]);
    }
    // Bounded transactions keep foreground writes from waiting on a long imported thread.
    let next = 0;
    while (next < rows.length) {
      items += yield* sql.withTransaction(
        Effect.gen(function* () {
          const first = next;
          const startedAt = yield* Clock.currentTimeMillis;
          let changed = 0;
          let written = 0;
          while (next < rows.length && next - first < BATCH_SIZE && written < BATCH_BYTES) {
            // Commit cost follows the bytes written, and decoding large outputs takes time too.
            if (next > first && (yield* Clock.currentTimeMillis) - startedAt >= BATCH_BUDGET_MS)
              break;
            const turnItemId = rows[next++]!.turn_item_id;
            const outcome = yield* Effect.gen(function* () {
              // Read inside the write transaction so a concurrent rewrite is never overwritten.
              const current = yield* sql<{ readonly payload_json: string }>`
              SELECT payload_json FROM orchestration_v2_projection_turn_items
              WHERE turn_item_id = ${turnItemId}
            `;
              const row = current[0];
              if (row === undefined) return 0;
              // An unreadable row stays as it is rather than stopping every later startup's pass.
              const decoded = yield* decodeItem(row.payload_json).pipe(Effect.option);
              if (decoded._tag === "None") return 0;
              const item = decoded.value;
              if (!item.legacyActivities?.length) return 0;
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
              if (activities.length !== item.legacyActivities.length) return 0;
              const rederived = legacyActivityTurnItem(
                { id: item.id, threadId: item.threadId, ordinal: item.ordinal },
                activities,
              );
              if (rederived === null || rederived.type !== item.type) return 0;
              const ordered = activities.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
              const terminal =
                ordered.findLast((activity) => activity.kind === "tool.completed") ??
                ordered.at(-1);
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
                  (item.input === undefined ||
                    NodeUtil.isDeepStrictEqual(item.input, payload.data)) &&
                  rederived.input !== undefined &&
                  !NodeUtil.isDeepStrictEqual(item.input, rederived.input)
                )
                  patch.input = rederived.input;
                if (item.output === undefined && rederived.output !== undefined)
                  patch.output = rederived.output;
              }
              if (Object.keys(patch).length === 0) return 0;
              // Merge into the stored JSON so unrelated fields and activity references stay intact.
              const stored = yield* decodeStored(row.payload_json);
              const json = yield* encodeStored({ ...stored, ...patch });
              yield* sql`CREATE TABLE IF NOT EXISTS styal_legacy_v1_rederived_items (
                turn_item_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
                previous_fields_json TEXT NOT NULL, absent_fields_json TEXT NOT NULL,
                rederived_at TEXT NOT NULL
              )`;
              // Only the fields this pass changes, so restoring them never brings back an old ordinal.
              const changedFields = Object.keys(patch);
              const previousFields = Object.fromEntries(
                changedFields
                  .filter((field) => field in stored)
                  .map((field) => [field, stored[field]]),
              );
              const absentFields = changedFields.filter((field) => !(field in stored));
              const rederivedAt = DateTime.formatIso(yield* DateTime.now);
              yield* sql`INSERT INTO styal_legacy_v1_rederived_items
              (turn_item_id, thread_id, previous_fields_json, absent_fields_json, rederived_at)
              VALUES (${item.id}, ${threadId}, ${yield* encodeStored(previousFields)},
                ${yield* encodeFieldNames(absentFields)}, ${rederivedAt})
              ON CONFLICT DO NOTHING`;
              yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = ${json} WHERE turn_item_id = ${item.id}`;
              const sequences = eventSequences.get(item.id) ?? [];
              if (sequences.length > 0)
                yield* sql`UPDATE orchestration_events SET payload_json = ${json} WHERE sequence IN ${sql.in(sequences)}`;
              yield* sql`INSERT INTO orchestration_v2_projection_metadata (projection_name, schema_version, last_sequence, updated_at)
              VALUES (${FENCE_PENDING}, 1, 0, ${rederivedAt}) ON CONFLICT(projection_name) DO NOTHING`;
              return Buffer.byteLength(json) * (1 + sequences.length);
            }).pipe(
              // One item that cannot be re-derived is left as it is and retried on a later start.
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterrupts(cause),
                (cause) =>
                  Effect.logWarning("Re-deriving an imported v1 tool item failed", {
                    turnItemId,
                    cause,
                  }).pipe(Effect.as(-1)),
              ),
            );
            if (outcome < 0) {
              failed++;
              continue;
            }
            if (outcome === 0) continue;
            written += outcome;
            changed++;
          }
          return changed;
        }),
      );
      yield* Effect.yieldNow;
    }
  }
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const finishedAt = DateTime.formatIso(yield* DateTime.now);
      const pending = yield* sql`
        SELECT 1 FROM orchestration_v2_projection_metadata WHERE projection_name = ${FENCE_PENDING}`;
      if (pending.length > 0) {
        yield* sql`UPDATE sqlite_sequence
        SET seq = MAX(seq, (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events)) + 1
        WHERE name = 'orchestration_events'`;
        yield* sql`INSERT INTO orchestration_v2_projection_metadata (projection_name, schema_version, last_sequence, updated_at)
        VALUES ('history-rewrite-fence', 1, (SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'), ${finishedAt})
        ON CONFLICT(projection_name) DO UPDATE SET last_sequence = excluded.last_sequence, updated_at = excluded.updated_at`;
        yield* sql`DELETE FROM orchestration_v2_projection_metadata WHERE projection_name = ${FENCE_PENDING}`;
      }
      if (failed === 0) {
        yield* sql`INSERT INTO orchestration_v2_projection_metadata (projection_name, schema_version, last_sequence, updated_at)
        VALUES (${DONE_MARKER}, 1, 0, ${finishedAt}) ON CONFLICT(projection_name) DO NOTHING`;
      }
    }),
  );
  const result = { threads: threads.length, items, failed };
  if (items > 0 || failed > 0) yield* Effect.logInfo("Re-derived imported v1 tool items", result);
  return result;
});
