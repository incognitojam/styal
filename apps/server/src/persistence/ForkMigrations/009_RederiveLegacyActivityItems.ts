import { OrchestrationV2TurnItemJson } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { legacyActivityTurnItem } from "../../orchestration-v2/legacy/LegacyHistoricalItems.ts";

const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));
const encodeItem = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));

const ITEM_EVENT_MARKER = ":item:import:v1:activity:";
const PAGE_SIZE = 200;

/**
 * Earlier V1 history imports showed informational activity as warning notices and took a
 * tool's status from an in-progress update logged alongside its completion. Re-derive those
 * items through the current converter from the V1 activity each one retains: rewrite changed
 * items in their event and projection, and drop ones the converter now skips. Events and
 * projection rows store the same encoded item, so both take the same payload. The rewrite
 * moves the history fence as fork migration 8 does, so cached threads refresh.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TEMP TABLE rederived_legacy_items (
      turn_item_id TEXT PRIMARY KEY,
      type TEXT,
      status TEXT,
      updated_at TEXT,
      payload_json TEXT
    )
  `;
  let after = "";
  while (true) {
    const rows = yield* sql<{ readonly turn_item_id: string; readonly payload_json: string }>`
      SELECT turn_item_id, payload_json
      FROM orchestration_v2_projection_turn_items
      WHERE turn_item_id LIKE 'import:v1:activity:%'
        AND turn_item_id > ${after}
        AND type <> 'subagent'
        AND (type = 'system_notice' OR status = 'interrupted')
      ORDER BY turn_item_id
      LIMIT ${PAGE_SIZE}
    `;
    for (const row of rows) {
      const item = yield* decodeItem(row.payload_json);
      if (item.legacyActivities === undefined) continue;
      const rederived = legacyActivityTurnItem(
        { id: item.id, threadId: item.threadId, ordinal: item.ordinal },
        item.legacyActivities,
      );
      if (rederived === null) {
        yield* sql`INSERT INTO rederived_legacy_items (turn_item_id) VALUES (${item.id})`;
        continue;
      }
      const payloadJson = yield* encodeItem(rederived);
      if (payloadJson === row.payload_json) continue;
      yield* sql`
        INSERT INTO rederived_legacy_items (turn_item_id, type, status, updated_at, payload_json)
        VALUES (${item.id}, ${rederived.type}, ${rederived.status}, ${DateTime.formatIso(rederived.updatedAt)}, ${payloadJson})
      `;
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < PAGE_SIZE) break;
    after = last.turn_item_id;
  }

  // Importers write each item under `<prefix>:item:<turn item id>` with varying prefixes.
  yield* sql`
    CREATE TEMP TABLE rederived_legacy_events AS
    SELECT event.sequence, repair.payload_json
    FROM orchestration_events AS event
    JOIN rederived_legacy_items AS repair
      ON repair.turn_item_id =
        substr(event.event_id, instr(event.event_id, ${ITEM_EVENT_MARKER}) + length(':item:'))
    WHERE event.application_event_version = 2
      AND event.event_type = 'turn-item.updated'
      AND instr(event.event_id, ${ITEM_EVENT_MARKER}) > 0
  `;
  yield* sql`
    DELETE FROM orchestration_events
    WHERE sequence IN (SELECT sequence FROM rederived_legacy_events WHERE payload_json IS NULL)
  `;
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = (
      SELECT payload_json FROM rederived_legacy_events
      WHERE rederived_legacy_events.sequence = orchestration_events.sequence
    )
    WHERE sequence IN (SELECT sequence FROM rederived_legacy_events WHERE payload_json IS NOT NULL)
  `;
  yield* sql`
    DELETE FROM orchestration_v2_turn_item_positions
    WHERE turn_item_id IN (
      SELECT turn_item_id FROM rederived_legacy_items WHERE payload_json IS NULL
    )
  `;
  yield* sql`
    DELETE FROM orchestration_v2_projection_turn_items
    WHERE turn_item_id IN (
      SELECT turn_item_id FROM rederived_legacy_items WHERE payload_json IS NULL
    )
  `;
  yield* sql`
    UPDATE orchestration_v2_projection_turn_items
    SET
      type = repair.type,
      status = repair.status,
      updated_at = repair.updated_at,
      payload_json = repair.payload_json
    FROM rederived_legacy_items AS repair
    WHERE repair.turn_item_id = orchestration_v2_projection_turn_items.turn_item_id
      AND repair.payload_json IS NOT NULL
  `;
  const rewritten = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM rederived_legacy_events
  `;
  yield* sql`DROP TABLE rederived_legacy_events`;
  yield* sql`DROP TABLE rederived_legacy_items`;
  if ((rewritten[0]?.count ?? 0) === 0) return;
  yield* sql`
    UPDATE sqlite_sequence
    SET seq = MAX(seq, (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events)) + 1
    WHERE name = 'orchestration_events'
  `;
  yield* sql`
    UPDATE orchestration_v2_projection_metadata
    SET
      last_sequence = (SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE projection_name = 'history-rewrite-fence'
  `;
});
