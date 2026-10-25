import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ForkMigration0001 from "./ForkMigrations/001_ComposerDrafts.ts";
import ForkMigration0002 from "./ForkMigrations/002_WorkspacePortAllocations.ts";
import ForkMigration0003 from "./ForkMigrations/003_ProjectAdditionalInstructions.ts";
import ForkMigration0004 from "./ForkMigrations/004_ProjectionThreadLatestMessageAt.ts";
import ForkMigration0005 from "./ForkMigrations/005_ProjectionThreadTokenUsage.ts";
import ForkMigration0006 from "./ForkMigrations/006_LegacyTurnUsage.ts";
import ForkMigration0007 from "./ForkMigrations/007_DropUndisplayedLegacyActivityItems.ts";
import ForkMigration0008 from "./ForkMigrations/008_HistoryRewriteFence.ts";
import ForkMigration0009 from "./ForkMigrations/009_RederiveLegacyActivityItems.ts";
import ForkMigration0010 from "./ForkMigrations/010_HardwareLeases.ts";
import ForkMigration0011 from "./ForkMigrations/011_ProjectionProjectsOrganization.ts";
import ForkMigration0012 from "./ForkMigrations/012_DropComposerDrafts.ts";
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
  [4, "ProjectionThreadLatestMessageAt", ForkMigration0004],
  [5, "ProjectionThreadTokenUsage", ForkMigration0005],
  [6, "LegacyTurnUsage", ForkMigration0006],
  [7, "DropUndisplayedLegacyActivityItems", ForkMigration0007],
  [8, "HistoryRewriteFence", ForkMigration0008],
  [9, "RederiveLegacyActivityItems", ForkMigration0009],
  [10, "HardwareLeases", ForkMigration0010],
  [11, "ProjectionProjectsOrganization", ForkMigration0011],
  [12, "DropComposerDrafts", ForkMigration0012],
] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

const makeForkMigrationLoader = (throughId?: number) =>
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

const MISPLACED_LATEST_MESSAGE_MIGRATION_ID = 51;
const MISPLACED_LATEST_MESSAGE_MIGRATION_NAME = "ProjectionThreadLatestMessageAt";

/**
 * Nightlies from 2026-09-29 recorded fork migration `ProjectionThreadLatestMessageAt` as upstream
 * migration 51, which would make the migrator skip upstream's own migration 51. Dropping that
 * record lets upstream 51 run; fork migration 4 then finds the column in place and only records it.
 */
const releaseMisplacedLatestMessageMigration = Effect.fn("releaseMisplacedLatestMessageMigration")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const upstreamMigrationTables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
    if (upstreamMigrationTables.length === 0) return false;
    const misplaced = yield* sql<{ readonly migration_id: number }>`
    SELECT migration_id
    FROM effect_sql_migrations
    WHERE migration_id = ${MISPLACED_LATEST_MESSAGE_MIGRATION_ID}
      AND name = ${MISPLACED_LATEST_MESSAGE_MIGRATION_NAME}
  `;
    if (misplaced.length === 0) return false;
    yield* sql`
    DELETE FROM effect_sql_migrations
    WHERE migration_id = ${MISPLACED_LATEST_MESSAGE_MIGRATION_ID}
      AND name = ${MISPLACED_LATEST_MESSAGE_MIGRATION_NAME}
  `;
    return true;
  },
);

const UPSTREAM_V1_HISTORY_DROP_MIGRATION_ID = 63;

/**
 * Upstream migration 63 drops V1 projections the lazy V1 thread import still reads. Renaming them
 * to fork-owned tables first keeps that migration verbatim and keeps their indexes. A database
 * another build took past 63 has lost this history and gets empty tables, so readers need no
 * existence checks.
 */
const keepV1HistoryTables = Effect.fn("keepV1HistoryTables")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = new Set(
    (yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).map((table) => table.name),
  );
  if (tables.has("styal_legacy_v1_thread_activities") && tables.has("styal_legacy_v1_turns")) {
    return false;
  }
  const dropApplied =
    (yield* sql`
      SELECT 1 FROM effect_sql_migrations
      WHERE migration_id >= ${UPSTREAM_V1_HISTORY_DROP_MIGRATION_ID}
      LIMIT 1
    `).length > 0;
  const renamesV1 = (table: string) => !dropApplied && tables.has(table);
  yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!tables.has("styal_legacy_v1_thread_activities")) {
        if (renamesV1("projection_thread_activities")) {
          yield* sql`ALTER TABLE projection_thread_activities RENAME TO styal_legacy_v1_thread_activities`;
        } else {
          yield* sql`
            CREATE TABLE styal_legacy_v1_thread_activities (
              activity_id TEXT PRIMARY KEY,
              thread_id TEXT NOT NULL,
              turn_id TEXT,
              tone TEXT NOT NULL,
              kind TEXT NOT NULL,
              summary TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              sequence INTEGER
            )
          `;
          yield* sql`
            CREATE INDEX styal_legacy_v1_thread_activities_thread_idx
            ON styal_legacy_v1_thread_activities(thread_id, created_at, sequence, activity_id)
          `;
        }
      }
      if (!tables.has("styal_legacy_v1_turns")) {
        if (renamesV1("projection_turns")) {
          yield* sql`ALTER TABLE projection_turns RENAME TO styal_legacy_v1_turns`;
        } else {
          yield* sql`
            CREATE TABLE styal_legacy_v1_turns (
              row_id INTEGER PRIMARY KEY AUTOINCREMENT,
              thread_id TEXT NOT NULL,
              turn_id TEXT,
              pending_message_id TEXT,
              assistant_message_id TEXT,
              state TEXT NOT NULL,
              requested_at TEXT NOT NULL,
              started_at TEXT,
              completed_at TEXT,
              checkpoint_turn_count INTEGER,
              checkpoint_ref TEXT,
              checkpoint_status TEXT,
              checkpoint_files_json TEXT NOT NULL,
              source_proposed_plan_thread_id TEXT,
              source_proposed_plan_id TEXT,
              UNIQUE (thread_id, turn_id),
              UNIQUE (thread_id, checkpoint_turn_count)
            )
          `;
        }
      }
    }),
  );
  return true;
});

export interface RunAllMigrationsOptions {
  readonly forkToMigrationInclusive?: number | undefined;
}

export const runAllMigrations = Effect.fn("runAllMigrations")(function* ({
  forkToMigrationInclusive,
}: RunAllMigrationsOptions = {}) {
  if (yield* releaseMisplacedLatestMessageMigration()) {
    yield* Effect.log("Moved the latest message migration out of upstream migration history");
  }
  const beforeDrop = yield* runMigrations({
    toMigrationInclusive: UPSTREAM_V1_HISTORY_DROP_MIGRATION_ID - 1,
  });
  if (yield* keepV1HistoryTables()) {
    yield* Effect.log("Kept the V1 activity and turn history in fork tables");
  }
  const upstream = [...beforeDrop, ...(yield* runMigrations())];
  const fork = yield* runForkMigrations({ toMigrationInclusive: forkToMigrationInclusive });
  return { upstream, fork } as const;
});
