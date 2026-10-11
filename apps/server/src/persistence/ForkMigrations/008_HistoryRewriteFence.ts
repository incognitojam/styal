import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Fork migration 7 rewrote imported history in place, which clients holding cached threads
 * never observe; see orchestration-v2/historyRewriteFence.ts. The fence reserves the next event
 * sequence: every cached thread is strictly behind it, and events stored afterwards follow it.
 * Later migrations that rewrite history move the fence the same way.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO sqlite_sequence (name, seq)
    SELECT 'orchestration_events', 0
    WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'orchestration_events')
  `;
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
