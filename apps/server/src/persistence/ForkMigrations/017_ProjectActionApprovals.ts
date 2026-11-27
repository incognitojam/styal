import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE layout_action_command_approvals (
      project_id TEXT NOT NULL,
      command_hash TEXT NOT NULL,
      command_text TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      PRIMARY KEY (project_id, command_hash)
    )
  `;
});
