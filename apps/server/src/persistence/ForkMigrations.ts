import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import {
  DATABASE_MIGRATIONS_FINISHED_MESSAGE,
  DATABASE_MIGRATIONS_STARTED_MESSAGE,
} from "@t3tools/shared/databaseMigrationLog";
import ProjectActionApprovals from "./ForkMigrations/017_ProjectActionApprovals.ts";
import ProjectAdditionalInstructions from "./ForkMigrations/003_ProjectAdditionalInstructions.ts";
import { hasPendingMigrations, runMigrations } from "./Migrations.ts";

const FORK_MIGRATIONS_TABLE = "yngatech_sql_migrations";
// Fork migrations keep upstream's numeric sequence available for later releases.
const forkMigrationEntries = [
  [3, "ProjectAdditionalInstructions", ProjectAdditionalInstructions],
  [17, "ProjectActionApprovals", ProjectActionApprovals],
] as const;
const runFork = Migrator.make({});

const hasPendingForkMigrations = Effect.fn("hasPendingForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`SELECT 1 FROM sqlite_schema WHERE name = ${FORK_MIGRATIONS_TABLE}`;
  if (tables.length === 0) return true;
  const rows = yield* sql.unsafe<{ readonly migration_id: number }>(
    `SELECT migration_id FROM ${FORK_MIGRATIONS_TABLE} WHERE migration_id >= 17 LIMIT 1`,
  );
  return rows.length === 0;
});

export const hasPendingAllMigrations = Effect.fn("hasPendingAllMigrations")(function* () {
  return (yield* hasPendingMigrations()) || (yield* hasPendingForkMigrations());
});

export const runAllMigrations = Effect.fn("runAllMigrations")(function* () {
  const upstream = yield* runMigrations();
  const pending = yield* hasPendingForkMigrations();
  if (pending) yield* Effect.log(DATABASE_MIGRATIONS_STARTED_MESSAGE);
  const fork = yield* runFork({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
    table: FORK_MIGRATIONS_TABLE,
  });
  if (pending) yield* Effect.log(DATABASE_MIGRATIONS_FINISHED_MESSAGE);
  return { upstream, fork };
});
