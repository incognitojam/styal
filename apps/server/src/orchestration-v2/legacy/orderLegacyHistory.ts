import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * V1 imports write a thread's messages before its activity, so every imported tool call and
 * notice would follow the thread's last message. Re-ranks the thread's run-less items, which
 * hold all imported history, by start time. Ordinals change in positions, projection rows and
 * item events together, so a projection rebuild keeps the order. Runs own separate ordinal
 * bands and are untouched. Returns how many items moved.
 */
export const orderLegacyHistory = (sql: SqlClient.SqlClient, threadIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (threadIds.length === 0) return 0;
    yield* sql`
      CREATE TEMP TABLE IF NOT EXISTS legacy_history_order (
        thread_id TEXT NOT NULL,
        turn_item_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (thread_id, turn_item_id)
      )
    `;
    yield* sql`DELETE FROM legacy_history_order`;
    yield* sql`
      INSERT INTO legacy_history_order (thread_id, turn_item_id, ordinal)
      SELECT thread_id, turn_item_id, ordinal
      FROM (
        SELECT
          thread_id,
          turn_item_id,
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
    // Ranks are a permutation, so freeing the moved items' positions first avoids collisions.
    yield* sql`
      DELETE FROM orchestration_v2_turn_item_positions
      WHERE EXISTS (
        SELECT 1 FROM legacy_history_order AS moved
        WHERE moved.thread_id = orchestration_v2_turn_item_positions.thread_id
          AND moved.turn_item_id = orchestration_v2_turn_item_positions.turn_item_id
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
      SELECT thread_id, turn_item_id, ordinal FROM legacy_history_order
    `;
    yield* sql`
      UPDATE orchestration_v2_projection_turn_items
      SET ordinal = moved.ordinal, payload_json = json_set(payload_json, '$.ordinal', moved.ordinal)
      FROM legacy_history_order AS moved
      WHERE moved.thread_id = orchestration_v2_projection_turn_items.thread_id
        AND moved.turn_item_id = orchestration_v2_projection_turn_items.turn_item_id
    `;
    yield* sql`
      UPDATE orchestration_events
      SET payload_json = json_set(orchestration_events.payload_json, '$.ordinal', moved.ordinal)
      FROM legacy_history_order AS moved
      WHERE orchestration_events.application_event_version = 2
        AND orchestration_events.aggregate_kind = 'thread'
        AND orchestration_events.event_type = 'turn-item.updated'
        AND orchestration_events.stream_id IN ${sql.in(threadIds)}
        AND moved.thread_id = orchestration_events.stream_id
        AND moved.turn_item_id = json_extract(orchestration_events.payload_json, '$.id')
    `;
    yield* sql`DELETE FROM legacy_history_order`;
    return moved[0]?.count ?? 0;
  });
