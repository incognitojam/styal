import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS worktree_setup_state (
      worktree_path TEXT PRIMARY KEY NOT NULL,
      turn_item_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      command TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'interrupted')),
      evidence_version INTEGER,
      device TEXT,
      inode TEXT,
      git_directory TEXT,
      request_sequence INTEGER NOT NULL
    )
  `;
});
