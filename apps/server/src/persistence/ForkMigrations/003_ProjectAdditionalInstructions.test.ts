import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runAllMigrations } from "../ForkMigrations.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })))(
  "project instructions migration",
  (it) => {
    it.effect("adds nullable project text and keeps the fork ledger separate on restart", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runAllMigrations();
        const columns = yield* sql<{
          readonly name: string;
          readonly notnull: number;
        }>`PRAGMA table_info(projection_projects)`;
        const column = columns.find((column) => column.name === "additional_instructions");
        assert.equal(column?.notnull, 0);
        const fork = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
        }>`SELECT migration_id, name FROM yngatech_sql_migrations WHERE migration_id = 3`;
        assert.deepEqual(fork, [{ migration_id: 3, name: "ProjectAdditionalInstructions" }]);
        const again = yield* runAllMigrations();
        assert.deepEqual(again.fork, []);
      }),
    );
  },
);
