import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Composer drafts stay on each client; the server copy from migration 1 is no longer read. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE IF EXISTS composer_drafts`;
});
