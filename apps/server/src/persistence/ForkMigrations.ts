import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ForkMigration0001 from "./ForkMigrations/001_ComposerDrafts.ts";
import ForkMigration0002 from "./ForkMigrations/002_WorkspacePortAllocations.ts";
import UpstreamMigration0039 from "./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts";
import { runMigrations } from "./Migrations.ts";

const FORK_MIGRATIONS_TABLE = "yngatech_sql_migrations";
const LEGACY_COMPOSER_DRAFT_MIGRATION_ID = 39;
const LEGACY_COMPOSER_DRAFT_MIGRATION_NAME = "ComposerDrafts";
const UPSTREAM_MIGRATION_0039_NAME = "ProjectionProjectsDefaultThreadEnvMode";

/**
 * Fork migrations have their own append-only history so upstream can keep its
 * numeric migration sequence unchanged across rebases.
 */
export const forkMigrationEntries = [
  [1, "ComposerDrafts", ForkMigration0001],
  [2, "WorkspacePortAllocations", ForkMigration0002],
] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

export const makeForkMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      forkMigrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const runFork = Migrator.make({});

/**
 * Moves the composer-draft migration shipped by the fork out of upstream's
 * migration history. Matching both ID and name leaves canonical upstream
 * installations untouched.
 */
export const repairLegacyForkMigrationHistory = Effect.fn("repairLegacyForkMigrationHistory")(
  function* () {
    const sql = yield* SqlClient.SqlClient;

    // Let the stock migrator create its tracking table without running a fork
    // migration. The repair and the normal fork pass then share its schema.
    yield* runFork({
      loader: makeForkMigrationLoader(0),
      table: FORK_MIGRATIONS_TABLE,
    });

    const upstreamMigrationTables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
    if (upstreamMigrationTables.length === 0) {
      return false;
    }

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const legacyMigrations = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id
        FROM effect_sql_migrations
        WHERE migration_id = ${LEGACY_COMPOSER_DRAFT_MIGRATION_ID}
          AND name = ${LEGACY_COMPOSER_DRAFT_MIGRATION_NAME}
      `;
        if (legacyMigrations.length === 0) {
          return false;
        }

        // The legacy migration created this table. Reapplying its guarded body
        // protects databases whose migration record survived an interrupted copy.
        yield* ForkMigration0001;
        // Apply upstream 39 directly instead of relying on its numeric watermark.
        // A user may already have upstream 40 after briefly switching builds.
        yield* UpstreamMigration0039;
        yield* sql`
        INSERT INTO yngatech_sql_migrations (migration_id, name)
        VALUES (1, ${LEGACY_COMPOSER_DRAFT_MIGRATION_NAME})
      `;
        yield* sql`
        UPDATE effect_sql_migrations
        SET name = ${UPSTREAM_MIGRATION_0039_NAME}
        WHERE migration_id = ${LEGACY_COMPOSER_DRAFT_MIGRATION_ID}
          AND name = ${LEGACY_COMPOSER_DRAFT_MIGRATION_NAME}
      `;

        return true;
      }),
    );
  },
);

export interface RunForkMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

export const runForkMigrations = Effect.fn("runForkMigrations")(function* ({
  toMigrationInclusive,
}: RunForkMigrationsOptions = {}) {
  const executedMigrations = yield* runFork({
    loader: makeForkMigrationLoader(toMigrationInclusive),
    table: FORK_MIGRATIONS_TABLE,
  });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Fork database schema is current")
    : Effect.log("Fork migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});

export const runAllMigrations = Effect.fn("runAllMigrations")(function* () {
  const repairedLegacyHistory = yield* repairLegacyForkMigrationHistory();
  if (repairedLegacyHistory) {
    yield* Effect.log("Moved legacy composer draft migration into fork history");
  }

  const upstream = yield* runMigrations();
  const fork = yield* runForkMigrations();
  return { upstream, fork, repairedLegacyHistory } as const;
});
