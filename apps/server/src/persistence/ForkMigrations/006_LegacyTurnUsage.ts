import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE styal_projection_legacy_turn_usage (
      thread_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL
    )
  `;
});
