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
  // A database without events has no cached clients to refresh.
  const stored = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM (SELECT 1 FROM orchestration_events LIMIT 1)
  `;
  if ((stored[0]?.count ?? 0) === 0) return;
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
