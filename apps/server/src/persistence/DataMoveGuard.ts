// @effect-diagnostics nodeBuiltinImport:off - Startup validates the offline marker digest without opening another connection.
// @effect-diagnostics globalJsonInEffect:off - Digest the fixed completion metadata.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

const bridgeTable = "styal_data_move";
export const bridgeDefinition = `CREATE TABLE ${bridgeTable} (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  completed_at TEXT NOT NULL,
  tool_commit TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('cutover','rehearsal')),
  neutralisation_sha256 TEXT NOT NULL
)`;

export const readBridgeMarker = Effect.fn("DataMove.readBridgeMarker")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const objects = yield* sql<{
    sql: string;
  }>`SELECT sql FROM sqlite_schema WHERE tbl_name=${bridgeTable}`;
  if (!objects.length) return undefined;
  const invalid = () =>
    new Migrator.MigrationError({
      kind: "BadState",
      message:
        "Invalid data-move completion marker. Discard the copy and repeat archive → neutralise → migrate on a fresh offline copy.",
    });
  if (objects.length !== 1 || objects[0]!.sql !== bridgeDefinition) return yield* invalid();
  const rows = yield* sql<{
    singleton: number;
    format_version: number;
    completed_at: string;
    tool_commit: string;
    mode: string;
    neutralisation_sha256: string;
  }>`SELECT * FROM styal_data_move`;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    row.singleton !== 1 ||
    row.format_version !== 1 ||
    !Number.isFinite(Date.parse(row.completed_at)) ||
    !/^[a-f0-9]{40}$/.test(row.tool_commit) ||
    !["cutover", "rehearsal"].includes(row.mode) ||
    !/^[a-f0-9]{64}$/.test(row.neutralisation_sha256)
  )
    return yield* invalid();
  const neutralTable =
    yield* sql`SELECT 1 FROM sqlite_schema WHERE type='table' AND name='styal_neutralisation'`;
  if (neutralTable.length !== 1) return yield* invalid();
  const neutral = yield* sql`SELECT * FROM styal_neutralisation`;
  if (
    neutral.length !== 1 ||
    neutral[0]!.format_version !== 2 ||
    neutral[0]!.mode !== row.mode ||
    NodeCrypto.createHash("sha256").update(JSON.stringify(neutral)).digest("hex") !==
      row.neutralisation_sha256
  )
    return yield* invalid();
  return row;
});

export const guardDataMove = Effect.fn("DataMove.guardStartup")(function* (
  offlineDataMove = false,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`SELECT 1 FROM sqlite_schema WHERE name='yngatech_sql_migrations'`;
  if (!tables.length) return;
  const history =
    yield* sql`SELECT 1 FROM yngatech_sql_migrations WHERE migration_id < 17 AND migration_id <> 3 LIMIT 1`;
  if (!history.length) return;
  const marker = yield* readBridgeMarker();
  if (!offlineDataMove && marker === undefined)
    return yield* new Migrator.MigrationError({
      kind: "BadState",
      message:
        "Historical styal data requires the offline data-move procedure: archive → neutralise → migrate. Use a fresh offline copy; never migrate the live home.",
    });
});
