import { OrchestrationV2TurnItemJson } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { legacyActivityTurnItem } from "../../orchestration-v2/legacy/LegacyHistoricalItems.ts";
import { preserveLegacyPayloadSize } from "../../orchestration-v2/legacy/legacyPayloadEncoding.ts";
import { orderLegacyHistory } from "../../orchestration-v2/legacy/orderLegacyHistory.ts";

const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));
const encodeItem = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));

const ITEM_EVENT_MARKER = ":item:import:v1:activity:";
const PAGE_SIZE = 200;

/**
 * Earlier V1 imports misclassified informational activity and tool status. Re-derive those items
 * from their retained V1 activity, rewriting event and projection with the same payload and
 * dropping ones the converter now skips. The rewrite moves the history fence as fork migration 8
 * does, so cached threads refresh.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TEMP TABLE rederived_legacy_items (
      turn_item_id TEXT PRIMARY KEY,
      type TEXT,
      status TEXT,
      updated_at TEXT,
      projection_padding INTEGER,
      payload_json TEXT
    )
  `;
  let after = "";
  while (true) {
    const rows = yield* sql<{
      readonly turn_item_id: string;
      readonly payload_json: string;
      readonly type: string;
      readonly status: string;
      readonly updated_at: string;
    }>`
      SELECT turn_item_id, payload_json, type, status, updated_at
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
      const encoded = yield* encodeItem(rederived);
      if (encoded === row.payload_json) continue;
      const payloadJson = preserveLegacyPayloadSize(row.payload_json, encoded);
      const updatedAt = DateTime.formatIso(rederived.updatedAt);
      // These columns precede payload_json in the SQLite record. Compensate for shrinking
      // metadata so the unchanged activity array also stays at the same record offset.
      const projectionPadding = Math.max(
        0,
        Buffer.byteLength(row.type + row.status + row.updated_at) -
          Buffer.byteLength(rederived.type + rederived.status + updatedAt),
      );
      yield* sql`
        INSERT INTO rederived_legacy_items (turn_item_id, type, status, updated_at, projection_padding, payload_json)
        VALUES (${item.id}, ${rederived.type}, ${rederived.status}, ${updatedAt}, ${projectionPadding}, ${payloadJson})
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
  // The correlated event update below must look up one repair rather than scan all repairs.
  yield* sql`
    CREATE UNIQUE INDEX rederived_legacy_events_sequence_idx ON rederived_legacy_events(sequence)
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
      payload_json = printf('%*s', repair.projection_padding, '') || repair.payload_json
    FROM rederived_legacy_items AS repair
    WHERE repair.turn_item_id = orchestration_v2_projection_turn_items.turn_item_id
      AND repair.payload_json IS NOT NULL
  `;
  const rewritten = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM rederived_legacy_events
  `;
  yield* sql`DROP TABLE rederived_legacy_events`;
  yield* sql`DROP TABLE rederived_legacy_items`;
  const imported = yield* sql<{ readonly thread_id: string }>`
    SELECT DISTINCT thread_id
    FROM orchestration_v2_projection_turn_items
    WHERE turn_item_id LIKE 'import:v1:%' OR turn_item_id LIKE 'migration:v1:%'
  `;
  let moved = 0;
  for (let start = 0; start < imported.length; start += 100) {
    const threadIds = imported.slice(start, start + 100).map((row) => row.thread_id);
    moved += yield* orderLegacyHistory(sql, threadIds);
  }
  if ((rewritten[0]?.count ?? 0) === 0 && moved === 0) return;
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
