import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import {
  legacyPayloadWithOrdinal,
  legacyProjectionPayloadWithOrdinal,
} from "./legacyPayloadEncoding.ts";

const PAYLOAD_PAGE_SIZE = 20;

/**
 * V1 imports write messages before activity, so imported tool calls would follow the last
 * message. Re-ranks run-less items by start time, changing ordinals in positions, projection rows
 * and item events together so a projection rebuild keeps the order. Runs own separate ordinal
 * bands and are untouched.
 */
export const orderLegacyHistory = Effect.fn("orderLegacyHistory")(function* (
  sql: SqlClient.SqlClient,
  threadIds: ReadonlyArray<string>,
) {
  if (threadIds.length === 0) return 0;
  yield* sql`
      CREATE TEMP TABLE IF NOT EXISTS legacy_history_order (
        thread_id TEXT NOT NULL,
        turn_item_id TEXT NOT NULL,
        projection_rowid INTEGER NOT NULL UNIQUE,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (thread_id, turn_item_id)
      )
    `;
  yield* sql`DELETE FROM legacy_history_order`;
  yield* sql`
      INSERT INTO legacy_history_order (thread_id, turn_item_id, projection_rowid, ordinal)
      SELECT thread_id, turn_item_id, projection_rowid, ordinal
      FROM (
        SELECT
          thread_id,
          turn_item_id,
          rowid AS projection_rowid,
          ordinal AS previous,
          ROW_NUMBER() OVER (
            PARTITION BY thread_id
            ORDER BY json_extract(payload_json, '$.startedAt'), ordinal, turn_item_id
          ) AS ordinal
        FROM orchestration_v2_projection_turn_items
        WHERE run_id IS NULL AND thread_id IN ${sql.in(threadIds)}
      )
      WHERE ordinal <> previous
    `;
  const moved = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM legacy_history_order
    `;
  if ((moved[0]?.count ?? 0) === 0) return 0;
  // Ranks are a permutation, so freeing the moved items' positions first avoids collisions.
  // Restrict the outer scan as well as the lookup: other threads can have millions of positions.
  yield* sql`
      DELETE FROM orchestration_v2_turn_item_positions
      WHERE thread_id IN ${sql.in(threadIds)} AND EXISTS (
        SELECT 1 FROM legacy_history_order AS moved
        WHERE moved.thread_id = orchestration_v2_turn_item_positions.thread_id
          AND moved.turn_item_id = orchestration_v2_turn_item_positions.turn_item_id
      )
    `;
  yield* sql`
      INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
      SELECT thread_id, turn_item_id, ordinal FROM legacy_history_order
    `;
  let afterProjection = 0;
  while (true) {
    const rows = yield* sql<{
      readonly projection_rowid: number;
      readonly turn_item_id: string;
      readonly ordinal: number;
      readonly previous_ordinal: number;
      readonly payload_json: string;
    }>`
        SELECT moved.projection_rowid, moved.turn_item_id, moved.ordinal, item.ordinal AS previous_ordinal, item.payload_json
        FROM legacy_history_order AS moved
        JOIN orchestration_v2_projection_turn_items AS item ON item.rowid = moved.projection_rowid
        WHERE moved.projection_rowid > ${afterProjection}
        ORDER BY moved.projection_rowid
        LIMIT ${PAYLOAD_PAGE_SIZE}
      `;
    if (rows.length > 0) {
      const values = rows.map(
        (row) => sql`(
          ${row.projection_rowid}, ${row.ordinal},
          ${legacyProjectionPayloadWithOrdinal(row.payload_json, row.previous_ordinal, row.ordinal)}
        )`,
      );
      yield* sql`
          WITH updates (projection_rowid, ordinal, payload_json) AS (
            VALUES ${sql.join(", ", false)(values)}
          )
          UPDATE orchestration_v2_projection_turn_items
          SET ordinal = updates.ordinal, payload_json = updates.payload_json
          FROM updates
          WHERE orchestration_v2_projection_turn_items.rowid = updates.projection_rowid
        `;
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < PAYLOAD_PAGE_SIZE) break;
    afterProjection = last.projection_rowid;
  }
  yield* sql`
      CREATE TEMP TABLE IF NOT EXISTS legacy_history_events (
        sequence INTEGER PRIMARY KEY,
        ordinal INTEGER NOT NULL
      )
    `;
  yield* sql`DELETE FROM legacy_history_events`;
  yield* sql`
      INSERT INTO legacy_history_events (sequence, ordinal)
      SELECT event.sequence, moved.ordinal
      FROM orchestration_events AS event INDEXED BY idx_orchestration_events_agent_stream_sequence
      JOIN legacy_history_order AS moved
        ON moved.thread_id = event.stream_id
          AND moved.turn_item_id = json_extract(event.payload_json, '$.id')
      WHERE event.application_event_version = 2
        AND event.aggregate_kind = 'thread'
        AND event.event_type = 'turn-item.updated'
        AND event.stream_id IN ${sql.in(threadIds)}
    `;
  let afterEvent = 0;
  while (true) {
    const rows = yield* sql<{
      readonly sequence: number;
      readonly ordinal: number;
      readonly payload_json: string;
    }>`
        SELECT moved.sequence, moved.ordinal, event.payload_json
        FROM legacy_history_events AS moved
        JOIN orchestration_events AS event ON event.sequence = moved.sequence
        WHERE moved.sequence > ${afterEvent}
        ORDER BY moved.sequence
        LIMIT ${PAYLOAD_PAGE_SIZE}
      `;
    if (rows.length > 0) {
      const values = rows.map(
        (row) => sql`(
          ${row.sequence}, ${legacyPayloadWithOrdinal(row.payload_json, row.ordinal)}
        )`,
      );
      yield* sql`
          WITH updates (sequence, payload_json) AS (
            VALUES ${sql.join(", ", false)(values)}
          )
          UPDATE orchestration_events
          SET payload_json = updates.payload_json
          FROM updates
          WHERE orchestration_events.sequence = updates.sequence
        `;
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < PAYLOAD_PAGE_SIZE) break;
    afterEvent = last.sequence;
  }
  yield* sql`DELETE FROM legacy_history_events`;
  yield* sql`DELETE FROM legacy_history_order`;
  return moved[0]?.count ?? 0;
});
