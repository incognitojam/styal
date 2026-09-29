import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN latest_message_at TEXT
  `;
  yield* sql`
    UPDATE projection_threads
    SET latest_message_at = (
      SELECT MAX(message.updated_at)
      FROM projection_thread_messages AS message
      WHERE message.thread_id = projection_threads.thread_id
    )
  `;
});
