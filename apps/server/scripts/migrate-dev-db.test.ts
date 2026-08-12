import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ForkMigration0001 from "../src/persistence/ForkMigrations/001_ComposerDrafts.ts";
import { runMigrations } from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";
import { runMigrateDevDb } from "./migrate-dev-db.ts";

const withDatabase = <A, E>(
  databasePath: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

/** A migrated source db with one thread per lifecycle state. Only
 * `stopped-thread` qualifies for the clone. */
const createFixtureSource = Effect.fn("createMigrateDevDbFixtureSource")(function* (
  baseDir: string,
  migrationState: "current" | "legacy-fork" = "current",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "state.sqlite");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* withDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (migrationState === "legacy-fork") {
        yield* runMigrations({ toMigrationInclusive: 38 });
        yield* ForkMigration0001;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (39, 'ComposerDrafts')
        `;
      } else {
        yield* runMigrations();
      }
      // The real shared db carries this column from a branch build without a
      // matching migration; reproduce that drift so the filter is exercised.
      yield* sql`ALTER TABLE projection_threads ADD COLUMN monitor_json TEXT`;

      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
        VALUES
        ('project-kept', 'Kept', '/tmp/kept', '[]', '2026-08-01', '2026-08-01', NULL),
        ('project-deleted', 'Deleted', '/tmp/deleted', '[]', '2026-08-01', '2026-08-02', '2026-08-02')`;

      const threads = [
        ["stopped-thread", "project-kept", "stopped", null, null],
        ["running-thread", "project-kept", "running", null, null],
        ["settled-thread", "project-kept", "stopped", "2026-08-01", null],
        ["monitored-thread", "project-kept", "stopped", null, '{"kind":"pr"}'],
        ["deleted-project-thread", "project-deleted", "stopped", null, null],
      ] as const;
      for (const [threadId, projectId, status, settledAt, monitorJson] of threads) {
        yield* sql`INSERT INTO projection_threads
          (thread_id, project_id, title, created_at, updated_at, settled_at, monitor_json)
          VALUES (${threadId}, ${projectId}, ${threadId}, '2026-08-01', '2026-08-01', ${settledAt}, ${monitorJson})`;
        yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, updated_at)
          VALUES (${threadId}, ${status}, '2026-08-01')`;
        yield* sql`INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
          VALUES (${`event-${threadId}`}, 'thread', ${threadId}, 0, 'thread.created', '2026-08-01', 'user', '{}', '{}')`;
      }
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('session-1', 'user', '[]', 'pairing', '2026-08-01', '2027-08-01')`;
    }),
  );
  return databasePath;
});

it.layer(NodeServices.layer)("migrate-dev-db", (it) => {
  it.effect("keeps only stopped threads from live projects and clears auth state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-src-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-dest-" });
      const source = yield* createFixtureSource(sourceDir);

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      );

      assert.equal(result.databasePath, path.join(destDir, "userdata", "state.sqlite"));
      const kept = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const threads = yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM projection_threads ORDER BY thread_id`;
          const events = yield* sql<{ stream_id: string }>`
            SELECT stream_id FROM orchestration_events`;
          const [auth] = yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM auth_sessions`;
          return { threads, events, authCount: auth?.count ?? 0 };
        }),
      );
      assert.deepStrictEqual(
        kept.threads.map((row) => row.thread_id),
        ["stopped-thread"],
      );
      assert.deepStrictEqual(
        kept.events.map((row) => row.stream_id),
        ["stopped-thread"],
      );
      assert.equal(kept.authCount, 0);
    }),
  );

  it.effect("fails loudly on a migration slot collision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-slot-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-slot-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      // Simulate another branch having claimed slot 1 first: the id is
      // recorded, so this checkout's migration 1 silently never runs.
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE effect_sql_migrations
            SET name = 'SomebodyElsesMigration' WHERE migration_id = 1`;
        }),
      );

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSlotCollisionError");
      if (error._tag === "MigrateDevDbSlotCollisionError") {
        assert.equal(error.slot, 1);
        assert.equal(error.appliedName, "SomebodyElsesMigration");
      }
    }),
  );

  it.effect("repairs legacy fork migration history before pruning", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-legacy-" });
      const destDir = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-dev-db-legacy-dest-",
      });
      const source = yield* createFixtureSource(sourceDir, "legacy-fork");
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT INTO composer_drafts (
              thread_id,
              revision,
              common_json,
              updated_at,
              client_mutation_id
            ) VALUES
              ('stopped-thread', 1, '{"text":"keep"}', '2026-08-09', 'kept-draft'),
              ('running-thread', 1, '{"text":"discard"}', '2026-08-09', 'discarded-draft')
          `;
        }),
      );

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      );

      assert.include(result.executedMigrations, "40_ProjectionProjectFaviconPath");
      const migrated = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const projectColumns = yield* sql<{ readonly name: string }>`
            PRAGMA table_info(projection_projects)
          `;
          const upstreamHistory = yield* sql<{
            readonly migration_id: number;
            readonly name: string;
          }>`
            SELECT migration_id, name
            FROM effect_sql_migrations
            WHERE migration_id >= 39
            ORDER BY migration_id
          `;
          const forkHistory = yield* sql<{
            readonly migration_id: number;
            readonly name: string;
          }>`
            SELECT migration_id, name
            FROM yngatech_sql_migrations
          `;
          const drafts = yield* sql<{ readonly thread_id: string }>`
            SELECT thread_id
            FROM composer_drafts
            ORDER BY thread_id
          `;
          return { projectColumns, upstreamHistory, forkHistory, drafts };
        }),
      );
      assert.includeMembers(
        migrated.projectColumns.map(({ name }) => name),
        ["default_thread_env_mode", "favicon_path"],
      );
      assert.deepStrictEqual(migrated.upstreamHistory, [
        {
          migration_id: 39,
          name: "ProjectionProjectsDefaultThreadEnvMode",
        },
        {
          migration_id: 40,
          name: "ProjectionProjectFaviconPath",
        },
      ]);
      assert.deepStrictEqual(migrated.forkHistory, [
        { migration_id: 1, name: "ComposerDrafts" },
        { migration_id: 2, name: "WorkspacePortAllocations" },
      ]);
      assert.deepStrictEqual(migrated.drafts, [{ thread_id: "stopped-thread" }]);
    }),
  );

  it.effect("refuses while a dev server holds the destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-busy-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-busy-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      // This test process stands in for a live dev server.
      const stateDir = path.join(destDir, "userdata");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(stateDir, "server-runtime.json"),
        `{"version":1,"pid":${process.pid}}`,
      );

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbServerRunningError");
      if (error._tag === "MigrateDevDbServerRunningError") {
        assert.equal(error.pid, process.pid);
      }
    }),
  );

  it.effect("refuses a source that resolves to a destination path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-overlap-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-overlap-dest-" });
      // A leftover snapshot from a prior failed run, passed as --source: it
      // must not be deleted before it is read.
      const leftoverSnapshot = path.join(destDir, "userdata", "state.sqlite.migrate-dev-db-tmp");
      yield* fs.makeDirectory(path.dirname(leftoverSnapshot), { recursive: true });
      yield* fs.writeFileString(leftoverSnapshot, "not a real db");

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source: leftoverSnapshot, projects: 5, threadsPerProject: 10 },
        { sharedHome: sharedDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSourceIsDestinationError");
      assert.equal(yield* fs.exists(leftoverSnapshot), true);
    }),
  );

  it.effect("refuses to rebuild the shared home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-shared-" });
      const source = yield* createFixtureSource(sourceDir);

      const error = yield* runMigrateDevDb(
        { baseDir: sourceDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSharedHomeError");
    }),
  );
});
