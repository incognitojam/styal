import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Short-lived notices agents leave for other threads in a project. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_notices (
      notice_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      author_thread_id TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_notices_project_expires
    ON project_notices (project_id, expires_at)
  `;
});
