import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Project kind ("repository" | "workspace"). NULL means "repository". */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!columns.some((column) => column.name === "kind")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN kind TEXT
    `;
  }
});
