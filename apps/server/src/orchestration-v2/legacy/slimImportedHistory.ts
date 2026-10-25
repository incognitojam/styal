import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import { recordedCommandOutput } from "../CommandOutputQuery.ts";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

const ITEM_EVENT_MARKER = ":item:import:v1:activity:";
const DONE_MARKER = "legacy-activity-references";

/**
 * Output and exit code a converted command recorded only in its V1 payloads, or null when
 * the item already carries them or the payloads hold none.
 */
function foldedCommandOutput(
  json: string,
): { output: string | null; exitCode: number | null } | null {
  const item = decodeJson(json);
  if (item._tag === "None" || !isRecord(item.value)) return null;
  const recorded = recordedCommandOutput(item.value);
  const output = item.value.output === undefined ? recorded.output : null;
  const exitCode = item.value.exitCode === undefined ? recorded.exitCode : null;
  return output === null && exitCode === null ? null : { output, exitCode };
}

/**
 * Older imports embedded every V1 activity row in each item, stored as both an event and a
 * projection row. Rewrites one thread per transaction after startup so a large history never
 * delays readiness. The history fence moves once the pass finishes, since folded output can
 * change a command's failure state.
 */
export const slimImportedHistory = Effect.fn("slimImportedHistory")(function* (
  sql: SqlClient.SqlClient,
) {
  const done = yield* sql<{ readonly found: number }>`
      SELECT 1 AS found FROM orchestration_v2_projection_metadata
      WHERE projection_name = ${DONE_MARKER}
    `;
  if (done.length > 0) return { threads: 0, rows: 0 };
  const threads = yield* sql<{ readonly thread_id: string }>`
      SELECT DISTINCT thread_id
      FROM orchestration_v2_projection_turn_items
      WHERE turn_item_id LIKE 'import:v1:activity:%'
      ORDER BY thread_id
    `;
  let rows = 0;
  for (const { thread_id: threadId } of threads) {
    rows += yield* sql.withTransaction(
      Effect.gen(function* () {
        // Commands whose output only the V1 payloads recorded keep it on the item.
        const commands = yield* sql<{
          readonly source: "item" | "event";
          readonly key: string;
          readonly payload_json: string;
        }>`
            SELECT 'item' AS source, turn_item_id AS key, payload_json
            FROM orchestration_v2_projection_turn_items
            WHERE thread_id = ${threadId}
              AND turn_item_id LIKE 'import:v1:activity:%'
              AND type = 'command_execution'
              AND json_type(payload_json, '$.legacyActivities[0].payload') IS NOT NULL
              AND (json_type(payload_json, '$.output') IS NULL
                OR json_type(payload_json, '$.exitCode') IS NULL)
            UNION ALL
            SELECT 'event' AS source, CAST(sequence AS TEXT) AS key, payload_json
            FROM orchestration_events INDEXED BY idx_orchestration_events_agent_stream_sequence
            WHERE application_event_version = 2
              AND aggregate_kind = 'thread'
              AND stream_id = ${threadId}
              AND event_type = 'turn-item.updated'
              AND instr(event_id, ${ITEM_EVENT_MARKER}) > 0
              AND json_extract(payload_json, '$.type') = 'command_execution'
              AND json_type(payload_json, '$.legacyActivities[0].payload') IS NOT NULL
              AND (json_type(payload_json, '$.output') IS NULL
                OR json_type(payload_json, '$.exitCode') IS NULL)
          `;
        for (const command of commands) {
          const folded = foldedCommandOutput(command.payload_json);
          if (folded === null) continue;
          const output = folded.output;
          const exitCode = folded.exitCode;
          if (command.source === "item") {
            yield* sql`
                UPDATE orchestration_v2_projection_turn_items
                SET payload_json = json_set(
                  payload_json,
                  '$.output', COALESCE(json_extract(payload_json, '$.output'), ${output}),
                  '$.exitCode', COALESCE(json_extract(payload_json, '$.exitCode'), ${exitCode})
                )
                WHERE turn_item_id = ${command.key}
              `;
          } else {
            yield* sql`
                UPDATE orchestration_events
                SET payload_json = json_set(
                  payload_json,
                  '$.output', COALESCE(json_extract(payload_json, '$.output'), ${output}),
                  '$.exitCode', COALESCE(json_extract(payload_json, '$.exitCode'), ${exitCode})
                )
                WHERE sequence = ${Number(command.key)}
              `;
          }
        }
        // Remove explicit nulls together; fields that were absent must stay absent.
        yield* sql`
            UPDATE orchestration_v2_projection_turn_items
            SET payload_json = CASE
              WHEN json_type(payload_json, '$.output') = 'null' THEN
                CASE WHEN json_type(payload_json, '$.exitCode') = 'null'
                  THEN json_remove(payload_json, '$.output', '$.exitCode')
                  ELSE json_remove(payload_json, '$.output') END
              ELSE json_remove(payload_json, '$.exitCode')
            END
            WHERE thread_id = ${threadId} AND turn_item_id LIKE 'import:v1:activity:%'
              AND (json_type(payload_json, '$.output') = 'null'
                OR json_type(payload_json, '$.exitCode') = 'null')
          `;
        yield* sql`
            UPDATE orchestration_events INDEXED BY idx_orchestration_events_agent_stream_sequence
            SET payload_json = CASE
              WHEN json_type(payload_json, '$.output') = 'null' THEN
                CASE WHEN json_type(payload_json, '$.exitCode') = 'null'
                  THEN json_remove(payload_json, '$.output', '$.exitCode')
                  ELSE json_remove(payload_json, '$.output') END
              ELSE json_remove(payload_json, '$.exitCode')
            END
            WHERE application_event_version = 2 AND aggregate_kind = 'thread'
              AND stream_id = ${threadId} AND event_type = 'turn-item.updated'
              AND instr(event_id, ${ITEM_EVENT_MARKER}) > 0
              AND (json_type(payload_json, '$.output') = 'null'
                OR json_type(payload_json, '$.exitCode') = 'null')
          `;
        // Keep each activity reference, in order, without its payload.
        const items = yield* sql`
            UPDATE orchestration_v2_projection_turn_items
            SET payload_json = json_set(payload_json, '$.legacyActivities', (
              SELECT json_group_array(json(json_remove(activity.value, '$.payload')))
              FROM (
                SELECT value
                FROM json_each(orchestration_v2_projection_turn_items.payload_json, '$.legacyActivities')
                ORDER BY key
              ) AS activity
            ))
            WHERE thread_id = ${threadId}
              AND turn_item_id LIKE 'import:v1:activity:%'
              AND json_type(payload_json, '$.legacyActivities[0].payload') IS NOT NULL
            RETURNING 1
          `;
        const events = yield* sql`
            UPDATE orchestration_events INDEXED BY idx_orchestration_events_agent_stream_sequence
            SET payload_json = json_set(payload_json, '$.legacyActivities', (
              SELECT json_group_array(json(json_remove(activity.value, '$.payload')))
              FROM (
                SELECT value
                FROM json_each(orchestration_events.payload_json, '$.legacyActivities')
                ORDER BY key
              ) AS activity
            ))
            WHERE application_event_version = 2
              AND aggregate_kind = 'thread'
              AND stream_id = ${threadId}
              AND event_type = 'turn-item.updated'
              AND instr(event_id, ${ITEM_EVENT_MARKER}) > 0
              AND json_type(payload_json, '$.legacyActivities[0].payload') IS NOT NULL
            RETURNING 1
          `;
        return items.length + events.length;
      }),
    );
    yield* Effect.yieldNow;
  }
  yield* sql.withTransaction(
    Effect.gen(function* () {
      if (rows > 0) {
        yield* sql`
            UPDATE sqlite_sequence
            SET seq = MAX(seq, (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events)) + 1
            WHERE name = 'orchestration_events'
          `;
        yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name, schema_version, last_sequence, updated_at
            )
            VALUES (
              'history-rewrite-fence', 1,
              (SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'),
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            )
            ON CONFLICT(projection_name) DO UPDATE SET
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `;
      }
      yield* sql`
          INSERT INTO orchestration_v2_projection_metadata (
            projection_name, schema_version, last_sequence, updated_at
          )
          VALUES (${DONE_MARKER}, 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ON CONFLICT(projection_name) DO NOTHING
        `;
    }),
  );
  return { threads: threads.length, rows };
});
