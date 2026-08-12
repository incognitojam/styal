import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Stable, environment-local port ranges assigned to workspace paths. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workspace_port_allocations (
      workspace_path TEXT PRIMARY KEY NOT NULL,
      base_port INTEGER NOT NULL UNIQUE
        CHECK (base_port >= 20000 AND base_port <= 29990 AND base_port % 10 = 0)
    )
  `;
});
