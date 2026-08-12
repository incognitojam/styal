import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ForkMigration0001 from "./ForkMigrations/001_ComposerDrafts.ts";
import {
  forkMigrationEntries,
  forkMigrationManifest,
  repairLegacyForkMigrationHistory,
  runAllMigrations,
} from "./ForkMigrations.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const legacyForkLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const switchedBuildLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const upstreamLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

legacyForkLayer("ForkMigrations legacy fork upgrade", (it) => {
  it.effect("upgrades databases that recorded the composer table as upstream migration 39", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 38 });
      yield* ForkMigration0001;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (39, 'ComposerDrafts')
      `;
      yield* sql`
        INSERT INTO composer_drafts (
          thread_id,
          revision,
          common_json,
          updated_at,
          client_mutation_id
        ) VALUES (
          'legacy-draft-thread',
          3,
          '{"text":"keep me"}',
          '2026-08-09T00:00:00.000Z',
          'legacy-write'
        )
      `;

      const result = yield* runAllMigrations();

      assert.isTrue(result.repairedLegacyHistory);
      assert.deepStrictEqual(result.upstream, [[40, "ProjectionProjectFaviconPath"]]);
      assert.deepStrictEqual(result.fork, [[2, "WorkspacePortAllocations"]]);

      const upstreamHistory = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id >= 39
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(upstreamHistory, [
        {
          migration_id: 39,
          name: "ProjectionProjectsDefaultThreadEnvMode",
        },
        {
          migration_id: 40,
          name: "ProjectionProjectFaviconPath",
        },
      ]);

      const forkHistory = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM yngatech_sql_migrations
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(forkHistory, [
        { migration_id: 1, name: "ComposerDrafts" },
        { migration_id: 2, name: "WorkspacePortAllocations" },
      ]);

      const projectColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.includeMembers(
        projectColumns.map(({ name }) => name),
        ["default_thread_env_mode", "favicon_path"],
      );

      const draftRows = yield* sql<{
        readonly thread_id: string;
        readonly revision: number;
        readonly common_json: string | null;
      }>`
        SELECT thread_id, revision, common_json
        FROM composer_drafts
        WHERE thread_id = 'legacy-draft-thread'
      `;
      assert.deepStrictEqual(draftRows, [
        {
          thread_id: "legacy-draft-thread",
          revision: 3,
          common_json: '{"text":"keep me"}',
        },
      ]);

      const secondRun = yield* runAllMigrations();
      assert.deepStrictEqual(secondRun, {
        upstream: [],
        fork: [],
        repairedLegacyHistory: false,
      });
    }),
  );
});

switchedBuildLayer("ForkMigrations switched-build upgrade", (it) => {
  it.effect("repairs upstream 39 even when a later upstream migration is recorded", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 38 });
      yield* ForkMigration0001;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (39, 'ComposerDrafts'), (40, 'ProjectionProjectFaviconPath')
      `;

      const result = yield* runAllMigrations();

      assert.isTrue(result.repairedLegacyHistory);
      assert.deepStrictEqual(result.upstream, []);
      const projectColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.include(
        projectColumns.map(({ name }) => name),
        "default_thread_env_mode",
      );

      const upstreamHistory = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id >= 39
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(upstreamHistory, [
        {
          migration_id: 39,
          name: "ProjectionProjectsDefaultThreadEnvMode",
        },
        {
          migration_id: 40,
          name: "ProjectionProjectFaviconPath",
        },
      ]);
    }),
  );
});

upstreamLayer("ForkMigrations canonical upstream upgrade", (it) => {
  it.effect("leaves canonical upstream migration 39 untouched", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      assert.isFalse(yield* repairLegacyForkMigrationHistory());
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
  ]);
});
