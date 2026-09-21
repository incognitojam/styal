import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { forkMigrationEntries, forkMigrationManifest, runAllMigrations } from "./ForkMigrations.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const upstreamLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

upstreamLayer("ForkMigrations canonical upstream upgrade", (it) => {
  it.effect("leaves canonical upstream migration 39 untouched", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      yield* runAllMigrations();

      const upstreamMigration = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id = 39
      `;
      assert.deepStrictEqual(upstreamMigration, [
        {
          migration_id: 39,
          name: "ProjectionProjectsDefaultThreadEnvMode",
        },
      ]);

      const forkHistory = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM yngatech_sql_migrations
      `;
      assert.deepStrictEqual(forkHistory, [
        { migration_id: 1, name: "ComposerDrafts" },
        { migration_id: 2, name: "WorkspacePortAllocations" },
        { migration_id: 3, name: "ProjectAdditionalInstructions" },
      ]);
    }),
  );
});

it("keeps fork migration IDs sequential from 1", () => {
  assert.deepStrictEqual(
    forkMigrationEntries.map(([id]) => id),
    forkMigrationEntries.map((_, index) => index + 1),
  );
});

it("keeps fork migrations out of the upstream manifest", () => {
  assert.notInclude(
    migrationManifest.map(([, name]) => name as string),
    "ComposerDrafts",
  );
  assert.notInclude(
    migrationManifest.map(([, name]) => name as string),
    "WorkspacePortAllocations",
  );
  assert.deepStrictEqual(forkMigrationManifest, [
    [1, "ComposerDrafts"],
    [2, "WorkspacePortAllocations"],
    [3, "ProjectAdditionalInstructions"],
  ]);
});
