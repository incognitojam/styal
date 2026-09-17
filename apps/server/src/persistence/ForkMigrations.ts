import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";

import ForkMigration0001 from "./ForkMigrations/001_ComposerDrafts.ts";
import ForkMigration0002 from "./ForkMigrations/002_WorkspacePortAllocations.ts";
import ForkMigration0003 from "./ForkMigrations/003_ProjectAdditionalInstructions.ts";
import { runMigrations } from "./Migrations.ts";

const FORK_MIGRATIONS_TABLE = "yngatech_sql_migrations";
/**
 * Fork migrations have their own append-only history so upstream can keep its
 * numeric migration sequence unchanged across rebases.
 */
export const forkMigrationEntries = [
  [1, "ComposerDrafts", ForkMigration0001],
  [2, "WorkspacePortAllocations", ForkMigration0002],
  [3, "ProjectAdditionalInstructions", ForkMigration0003],
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
  const upstream = yield* runMigrations();
  const fork = yield* runForkMigrations();
  return { upstream, fork } as const;
});
