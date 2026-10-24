import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (columns.some((column) => column.name === "token_usage_json")) return;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN token_usage_json TEXT
  `;
  // The thread total travels on each turn's usage record; the newest one holds it.
  yield* sql`
    UPDATE projection_threads
    SET token_usage_json = (
      SELECT json_extract(activity.payload_json, '$.thread')
      FROM styal_legacy_v1_thread_activities AS activity
      WHERE activity.thread_id = projection_threads.thread_id
        AND activity.kind = 'turn.usage'
      ORDER BY activity.created_at DESC
      LIMIT 1
    )
  `;
});
