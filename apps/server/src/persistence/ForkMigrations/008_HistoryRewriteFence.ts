import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Fork migration 7 rewrote imported history in place, which clients holding cached threads
 * never observe. Fence everything stored so far; see orchestration-v2/historyRewriteFence.ts.
 * Later migrations that rewrite history move the fence the same way.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
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
      (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
    ON CONFLICT(projection_name) DO UPDATE SET
      last_sequence = excluded.last_sequence,
      updated_at = excluded.updated_at
  `;
});
