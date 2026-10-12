import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { recordedCommandOutput } from "../../orchestration-v2/CommandOutputQuery.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

const ITEM_EVENT_MARKER = ":item:import:v1:activity:";
const PAGE_SIZE = 500;

/**
 * Imported V1 history embedded every V1 activity row it was converted from in each item,
 * and stored the item twice, as an event and a projection row. The rows stay in the V1
 * source, so items now keep only a reference to each. Command output that was readable only
 * from those payloads is folded into the item first, so output queries return the same text.
 * Clients never received the payloads, but folded output can change a command's failure
 * state, so the history fence moves as fork migration 8 describes.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Commands whose output or exit code only the V1 payloads recorded.
  let after = "";
  let folded = 0;
  while (true) {
    const rows = yield* sql<{ readonly turn_item_id: string; readonly payload_json: string }>`
      SELECT turn_item_id, payload_json
      FROM orchestration_v2_projection_turn_items
      WHERE turn_item_id LIKE 'import:v1:activity:%'
        AND turn_item_id > ${after}
        AND type = 'command_execution'
        AND (
          json_extract(payload_json, '$.output') IS NULL
          OR json_extract(payload_json, '$.exitCode') IS NULL
        )
        AND json_extract(payload_json, '$.legacyActivities[0].payload') IS NOT NULL
      ORDER BY turn_item_id
      LIMIT ${PAGE_SIZE}
    `;
    for (const row of rows) {
      const payload = yield* decodeJson(row.payload_json);
      if (!isRecord(payload)) continue;
      const recorded = recordedCommandOutput(payload);
      if (recorded.output === null && recorded.exitCode === null) continue;
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET payload_json = json_set(
          payload_json,
          '$.output', COALESCE(json_extract(payload_json, '$.output'), ${recorded.output}),
          '$.exitCode', COALESCE(json_extract(payload_json, '$.exitCode'), ${recorded.exitCode})
        )
        WHERE turn_item_id = ${row.turn_item_id}
      `;
      folded += 1;
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < PAGE_SIZE) break;
    after = last.turn_item_id;
  }
  // json_set writes SQL NULL as JSON null; an absent output stays absent.
  yield* sql`
    UPDATE orchestration_v2_projection_turn_items
    SET payload_json = json_remove(payload_json, '$.output')
    WHERE turn_item_id LIKE 'import:v1:activity:%'
      AND json_type(payload_json, '$.output') = 'null'
  `;
  yield* sql`
    UPDATE orchestration_v2_projection_turn_items
    SET payload_json = json_remove(payload_json, '$.exitCode')
    WHERE turn_item_id LIKE 'import:v1:activity:%'
      AND json_type(payload_json, '$.exitCode') = 'null'
  `;

  const slimmed = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count
    FROM orchestration_v2_projection_turn_items
    WHERE turn_item_id LIKE 'import:v1:activity:%'
      AND json_extract(payload_json, '$.legacyActivities[0].payload') IS NOT NULL
  `;
  yield* sql`
    UPDATE orchestration_v2_projection_turn_items
    SET payload_json = json_set(
      payload_json,
      '$.legacyActivities',
      (
        SELECT json_group_array(json(json_remove(activity.value, '$.payload')))
        FROM (
          SELECT value
          FROM json_each(orchestration_v2_projection_turn_items.payload_json, '$.legacyActivities')
          ORDER BY key
        ) AS activity
      )
    )
    WHERE turn_item_id LIKE 'import:v1:activity:%'
      AND json_type(payload_json, '$.legacyActivities') = 'array'
  `;
  // Imported items have one event each, which stores the same encoded item as the projection.
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = item.payload_json
    FROM orchestration_v2_projection_turn_items AS item
    WHERE orchestration_events.application_event_version = 2
      AND orchestration_events.event_type = 'turn-item.updated'
      AND instr(orchestration_events.event_id, ${ITEM_EVENT_MARKER}) > 0
      AND item.turn_item_id = substr(
        orchestration_events.event_id,
        instr(orchestration_events.event_id, ${ITEM_EVENT_MARKER}) + length(':item:')
      )
      AND orchestration_events.payload_json <> item.payload_json
  `;
  if (folded === 0 && (slimmed[0]?.count ?? 0) === 0) return;
  yield* sql`
    UPDATE sqlite_sequence
    SET seq = MAX(seq, (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events)) + 1
    WHERE name = 'orchestration_events'
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_metadata (
      projection_name,
      schema_version,
      last_sequence,
      updated_at
    )
    VALUES (
      'history-rewrite-fence',
      1,
      (SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
    ON CONFLICT(projection_name) DO UPDATE SET
      last_sequence = excluded.last_sequence,
      updated_at = excluded.updated_at
  `;
});
