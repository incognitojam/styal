import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Early V1 imports turned runtime bookkeeping into turn items that render as warning notices;
 * drop those items with their events and positions. The kind list is frozen so later importer
 * changes cannot alter what this migration did.
 */
const UNDISPLAYED_ACTIVITY_KINDS = [
  "checkpoint.captured",
  "context-window.updated",
  "task.started",
  "task.updated",
  "tool.progress",
  "tool.started",
  "turn.plan.updated",
  "turn.usage",
  "worktree-setup",
];

const ITEM_EVENT_MARKER = ":item:import:v1:activity:";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TEMP TABLE undisplayed_legacy_items (turn_item_id TEXT PRIMARY KEY)`;
  // Completed tool groups hold almost all imported bytes and always include a displayed
  // kind; excluding them by column avoids parsing their payloads.
  yield* sql`
    INSERT INTO undisplayed_legacy_items (turn_item_id)
    SELECT item.turn_item_id
    FROM orchestration_v2_projection_turn_items AS item
    WHERE item.turn_item_id LIKE 'import:v1:activity:%'
      AND (item.type = 'system_notice' OR item.status <> 'completed')
      AND json_array_length(item.payload_json, '$.legacyActivities') > 0
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(item.payload_json, '$.legacyActivities') AS activity
        WHERE json_extract(activity.value, '$.kind') NOT IN ${sql.in(UNDISPLAYED_ACTIVITY_KINDS)}
      )
  `;
  // Importers write each item under `<prefix>:item:<turn item id>` with varying prefixes.
  yield* sql`
    DELETE FROM orchestration_events
    WHERE application_event_version = 2
      AND event_type = 'turn-item.updated'
      AND instr(event_id, ${ITEM_EVENT_MARKER}) > 0
      AND substr(event_id, instr(event_id, ${ITEM_EVENT_MARKER}) + length(':item:'))
        IN (SELECT turn_item_id FROM undisplayed_legacy_items)
  `;
  yield* sql`
    DELETE FROM orchestration_v2_turn_item_positions
    WHERE turn_item_id IN (SELECT turn_item_id FROM undisplayed_legacy_items)
  `;
  yield* sql`
    DELETE FROM orchestration_v2_projection_turn_items
    WHERE turn_item_id IN (SELECT turn_item_id FROM undisplayed_legacy_items)
  `;
  yield* sql`DROP TABLE undisplayed_legacy_items`;
});
