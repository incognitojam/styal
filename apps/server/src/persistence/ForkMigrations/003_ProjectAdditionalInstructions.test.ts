import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runForkMigrations } from "../ForkMigrations.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("003_ProjectAdditionalInstructions", (it) => {
  it.effect("adds nullable additional instructions to project projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      yield* runForkMigrations({ toMigrationInclusive: 2 });
      yield* runForkMigrations({ toMigrationInclusive: 3 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_projects)
      `;
      const additionalInstructions = columns.find(
        (column) => column.name === "additional_instructions",
      );

      assert.equal(additionalInstructions?.name, "additional_instructions");
      assert.equal(additionalInstructions?.notnull, 0);
    }),
  );
});
