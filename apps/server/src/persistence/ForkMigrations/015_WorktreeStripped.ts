import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS worktree_stripped (
    worktree_path TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    stripped_at TEXT NOT NULL
  )`;
});
