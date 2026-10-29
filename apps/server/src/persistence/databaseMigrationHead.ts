// @effect-diagnostics nodeBuiltinImport:off - read synchronously by the preflight subprocess and at startup.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import { FORK_MIGRATIONS_TABLE, forkMigrationManifest } from "./ForkMigrations.ts";
import { migrationManifest } from "./Migrations.ts";

const UPSTREAM_MIGRATIONS_TABLE = "effect_sql_migrations";

export const BUILD_MIGRATION_HEAD = Math.max(...migrationManifest.map(([id]) => id));
export const BUILD_FORK_MIGRATION_HEAD = Math.max(...forkMigrationManifest.map(([id]) => id));

function readRecordedMigrations(
  db: NodeSqlite.DatabaseSync,
  table: string,
): ReadonlyArray<{ readonly id: number; readonly name: string }> {
  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (hasTable === undefined) return [];
  return db
    .prepare(`SELECT migration_id, name FROM ${table} ORDER BY migration_id`)
    .all()
    .map((row) => ({ id: Number(row.migration_id), name: String(row.name) }));
}

export interface RecordedMigrations {
  readonly upstream: ReadonlyArray<{ readonly id: number; readonly name: string }>;
  readonly fork: ReadonlyArray<{ readonly id: number; readonly name: string }>;
}

/** Migrations the database records, read-only, in each of its two histories. A missing or new
 * database records none; one that exists but cannot be read is null, since its history is unknown. */
export function recordedMigrations(databasePath: string): RecordedMigrations | null {
  let db: NodeSqlite.DatabaseSync;
  try {
    db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  } catch {
    return NodeFS.existsSync(databasePath) ? null : { upstream: [], fork: [] };
  }
  try {
    return {
      upstream: readRecordedMigrations(db, UPSTREAM_MIGRATIONS_TABLE),
      fork: readRecordedMigrations(db, FORK_MIGRATIONS_TABLE),
    };
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // A read-only handle has nothing to flush; the result above already stands.
    }
  }
}

/** One number for both histories, so a track switch sees a migration in either. Releases come from
 * one linear main, where both heads only grow, so comparing the sums compares the releases. */
export function combinedMigrationHead(upstreamHead: number, forkHead: number): number {
  return upstreamHead + forkHead;
}

/** Highest migrations the database holds once this build's startup migrations have run, as one
 * number. A newer build may have recorded more than this build knows. Undefined when the database
 * is unreadable. */
export function databaseMigrationHead(databasePath: string): number | undefined {
  const recorded = recordedMigrations(databasePath);
  return recorded === null
    ? undefined
    : combinedMigrationHead(
        Math.max(BUILD_MIGRATION_HEAD, ...recorded.upstream.map(({ id }) => id)),
        Math.max(BUILD_FORK_MIGRATION_HEAD, ...recorded.fork.map(({ id }) => id)),
      );
}
