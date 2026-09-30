import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  // Databases that ran this as upstream migration 51 already have the column and keep it current.
  if (columns.some((column) => column.name === "latest_message_at")) return;

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
