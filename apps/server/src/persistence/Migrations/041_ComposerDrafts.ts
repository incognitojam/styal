import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Current-state storage for high-churn existing-thread composer drafts. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS composer_drafts (
      thread_id TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      common_json TEXT,
      updated_at TEXT NOT NULL,
      client_mutation_id TEXT NOT NULL
    )
  `;
});
