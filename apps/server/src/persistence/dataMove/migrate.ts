// @effect-diagnostics nodeBuiltinImport:off - Offline SQLite maintenance boundary.
// @effect-diagnostics globalJsonInEffect:off - Only fixed schema and aggregate reports leave this tool.
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runAllMigrations } from "../ForkMigrations.ts";
import { migrationManifest } from "../Migrations.ts";
import { bridgeDefinition, readBridgeMarker } from "../DataMoveGuard.ts";
import { projectionCodecs, columnCodecs } from "./codecs.ts";
import { verifyBridgeReaders } from "./bridgeReaders.ts";
import { archive } from "./archive.ts";
import { assertOffline, PreflightRefusal, scanPreflight } from "./preflight.ts";
import { neutralisationMarker, neutralisationState, requireSourceSchema } from "./neutralise.ts";
import { inspectTarget } from "./target.ts";
import source from "./source.json" with { type: "json" };
import { compareSchema, isSqliteStatistics, schemaHash } from "./schema.ts";
import bridgeSchema from "./bridgeSchema.json" with { type: "json" };
import leftovers from "./leftovers.json" with { type: "json" };

const refuse = (category: string) => new PreflightRefusal({ category });
const q = (name: string) => `"${name.replaceAll('"', '""')}"`;
const isRefusal = Schema.is(PreflightRefusal);
const quiet = Logger.layer([], { mergeWithExisting: false });
const connection = (filename: string, readonly = false) =>
  Layer.merge(
    NodeSqliteClient.layer({ filename, readonly, readerWorker: false, writerWorker: false }),
    quiet,
  );
const forkHead = [...source.forkLedger, { migration_id: 17, name: "ProjectActionApprovals" }];
const upstreamHead = migrationManifest.map(([migration_id, name]) => ({ migration_id, name }));

function ledgers(db: NodeSqlite.DatabaseSync, moved: boolean) {
  for (const [table, expected] of [
    ["effect_sql_migrations", moved ? upstreamHead : source.ledger],
    ["yngatech_sql_migrations", moved ? forkHead : source.forkLedger],
  ] as const) {
    const rows = db.prepare(`SELECT migration_id,name FROM ${table} ORDER BY migration_id`).all();
    if (JSON.stringify(rows) !== JSON.stringify(expected))
      throw refuse(
        moved ? "target-ledgers-required" : "source-ledgers-required-discard-partial-copy",
      );
  }
}
function movedSchema(db: NodeSqlite.DatabaseSync) {
  const markers = new Set([
    "styal_archive_raw_cells",
    "styal_archive_raw_manifest",
    "styal_neutralisation",
    "styal_data_move",
  ]);
  const objects = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name",
    )
    .all()
    .filter((row) => !markers.has(String(row.name)))
    .map((row) => ({
      type: String(row.type),
      name: String(row.name),
      table: String(row.tbl_name),
      hash: schemaHash(row.sql),
    }));
  if (Object.keys(compareSchema(objects, bridgeSchema)).length)
    throw refuse("unlisted-or-changed-target-schema");
}
function neutralState(filename: string) {
  const db = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
  try {
    const marker = neutralisationMarker(db);
    if (!marker) throw refuse("neutralisation-marker-required");
    const { before } = neutralisationState(
      db,
      marker.mode === "cutover" ? "cutover" : "rehearsal",
      DateTime.nowUnsafe(),
    );
    if (Object.values(before).some((n) => n > 0)) throw refuse("executable-state-remains");
    const rows = db.prepare("SELECT * FROM styal_neutralisation").all();
    const digest = NodeCrypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    return { mode: marker.mode, digest };
  } finally {
    db.close();
  }
}

const verifyMoved = Effect.fn("DataMove.verifyMoved")(function* (
  filename: string,
  expected: ReturnType<typeof neutralState>,
) {
  const sql = yield* SqlClient.SqlClient;
  const target = yield* inspectTarget();
  const db = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
  const remaining = yield* Effect.try({
    try: () => {
      try {
        ledgers(db, true);
        if (
          db
            .prepare("PRAGMA integrity_check")
            .all()
            .some((row) => row.integrity_check !== "ok")
        )
          throw refuse("integrity-check-failed");
        if (db.prepare("PRAGMA foreign_key_check").all().length)
          throw refuse("foreign-key-check-failed");
        movedSchema(db);
        const allowed = new Set([
          "styal_archive_raw_cells",
          "styal_archive_raw_manifest",
          "styal_neutralisation",
          "styal_data_move",
        ]);
        const remaining: Record<string, { rows: number; columns: string[] }> = {};
        for (const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()) {
          const table = String(row.name);
          if (allowed.has(table)) continue;
          if (isSqliteStatistics({ type: "table", name: table })) {
            remaining[table] = {
              rows: Number(db.prepare(`SELECT count(*) n FROM ${q(table)}`).get()!.n),
              columns: [],
            };
            continue;
          }
          const native = target.columns[table];
          const actualColumns = db.prepare(`PRAGMA table_xinfo(${q(table)})`).all();
          const extra = native
            ? db
                .prepare(`PRAGMA table_xinfo(${q(table)})`)
                .all()
                .map((c) => String(c.name))
                .filter((name) => !native.some((c) => c.name === name))
            : [];
          if (!native) {
            const pinned = source.definitions.find((d) => d.type === "table" && d.name === table);
            if (
              !pinned ||
              actualColumns.some((c) => !pinned.columns.some((p) => p.name === c.name))
            )
              throw refuse("unlisted-leftover-schema");
          }
          const known = leftovers[table as keyof typeof leftovers];
          if (
            (!native && !known?.table) ||
            (extra.length && (!known || JSON.stringify(extra) !== JSON.stringify(known.columns)))
          )
            throw refuse("unlisted-leftover-schema");
          if (!native || extra.length)
            remaining[table] = {
              rows: Number(db.prepare(`SELECT count(*) n FROM ${q(table)}`).get()!.n),
              columns: extra,
            };
        }
        return remaining;
      } finally {
        db.close();
      }
    },
    catch: (error) => (isRefusal(error) ? error : refuse("target-validation-failed")),
  });
  const archived = yield* archive(filename, true);
  const current = yield* Effect.try({
    try: () => neutralState(filename),
    catch: (error) => (isRefusal(error) ? error : refuse("neutralisation-invalid")),
  });
  if (current.digest !== expected.digest || current.mode !== expected.mode)
    return yield* refuse("neutralisation-marker-changed");
  const census = yield* scanPreflight(
    undefined,
    ["styal_archive_raw_cells", "styal_archive_raw_manifest"],
    false,
    true,
  );
  for (const key of [
    "nonpositive-event-sequence",
    "projection-version-not-2",
    "projection-cursor-missing",
    "unprojected-event-tail",
    "invalid-metadata-cursor",
    "pruning-beyond-projection",
    "unknown-event-application-version",
    "unknown-event-aggregate-kind",
  ]) {
    if (census.globals[key] !== 0) return yield* refuse("projection-consistency-required / " + key);
  }
  const rejected = Object.entries(census.tables).filter(
    ([table, counts]) => counts.rejected > 0 && table !== "orchestration_v2_effect_outbox",
  );
  if (Object.values(census.tables).some((counts) => counts.scanSkipped !== undefined))
    return yield* refuse("restart-reader-unsafe-integer");
  if (rejected.length) return yield* refuse("restart-reader-rejected");
  const tables: Record<string, { rows: number; rejected: number }> = {};
  for (const [table, counts] of Object.entries(census.tables))
    tables[table] = { rows: counts.rows, rejected: counts.rejected };
  const decodedRows = yield* verifyBridgeReaders();
  const notDecoded: Record<string, { rows: number; reason: string }> = {};
  for (const [table, columns] of Object.entries(target.columns)) {
    const counts = yield* sql.unsafe<{ n: number }>(`SELECT count(*) n FROM ${q(table)}`);
    const n = counts[0]!.n;
    const record = table.replace("orchestration_v2_projection_", "");
    if (
      table in decodedRows ||
      record in projectionCodecs ||
      table === "orchestration_events" ||
      table === "projection_projects"
    )
      continue;
    const existing = source.definitions.some((d) => d.name === table && d.type === "table");
    const derived =
      table.includes("_message_search") ||
      table.includes("_item_counts") ||
      table === "sqlite_sequence";
    if (!existing && !derived && n !== 0) return yield* refuse("new-table-not-empty");
    notDecoded[table] = {
      rows: n,
      reason: derived
        ? "derived SQL index/count or SQLite bookkeeping; integrity checked"
        : !existing
          ? "created empty by migrations; no source rows to decode"
          : "scalar SQL/legacy bookkeeping; no whole-row runtime codec",
    };
    if (columns.length === 0) return yield* refuse("target-schema-invalid");
  }
  for (const [table, detail] of Object.entries(remaining)) {
    if (
      isSqliteStatistics({ type: "table", name: table }) ||
      leftovers[table as keyof typeof leftovers]?.table
    )
      notDecoded[table] = {
        rows: detail.rows,
        reason: isSqliteStatistics({ type: "table", name: table })
          ? "SQLite ANALYZE bookkeeping; retained in place"
          : "retired fork table; no restart reader; retained in place",
      };
  }
  const decodedJsonColumns = Object.keys(columnCodecs).filter(
    (key) => !key.endsWith("scripts_json"),
  );
  notDecoded.orchestration_v2_effect_outbox = {
    rows: tables.orchestration_v2_effect_outbox!.rows,
    reason:
      "neutralised requests are terminal; restart claims only pending work; raw originals archived",
  };
  const [size] = yield* sql.unsafe<{ page_count: number }>("PRAGMA page_count");
  const [page] = yield* sql.unsafe<{ page_size: number }>("PRAGMA page_size");
  return {
    mode: current.mode,
    ledgers: { upstream: 117, fork: 17 },
    integrity: "ok",
    foreignKeys: "ok",
    archiveIntact: archived.archiveIntact,
    neutralisationUnchanged: true,
    tables,
    decodedRows,
    decodedJsonColumns,
    notDecoded,
    leftovers: remaining,
    databaseBytes: size!.page_count * page!.page_size,
  };
});

export const migrate = Effect.fn("DataMove.migrate")(function* (path: string, verify = false) {
  const filename = yield* Effect.try({
    try: () => {
      const filename = assertOffline(path);
      for (const suffix of ["-wal", "-shm", "-journal"]) assertOffline(filename + suffix);
      if (!NodeFS.existsSync(filename)) throw refuse("existing-database-required");
      return filename;
    },
    catch: (error) => (isRefusal(error) ? error : refuse("database-unavailable")),
  });
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const completed = yield* readBridgeMarker().pipe(
      Effect.mapError(() => refuse("completion-marker-invalid")),
    );
    if (verify && !completed) return yield* refuse("completion-marker-required");
    if (!completed)
      yield* Effect.try({
        try: () => {
          const db = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
          try {
            ledgers(db, false);
            requireSourceSchema(db);
          } finally {
            db.close();
          }
        },
        catch: (error) =>
          isRefusal(error) ? error : refuse("source-ledgers-required-discard-partial-copy"),
      });
    yield* archive(filename, true).pipe(
      Effect.mapError(() => refuse("archive-required-and-intact")),
    );
    const neutral = yield* Effect.try({
      try: () => neutralState(filename),
      catch: (error) => (isRefusal(error) ? error : refuse("neutralisation-invalid")),
    });
    if (
      completed &&
      (completed.neutralisation_sha256 !== neutral.digest || completed.mode !== neutral.mode)
    )
      return yield* refuse("neutralisation-marker-changed");
    const commit =
      completed?.tool_commit ??
      (yield* Effect.try({
        try: () =>
          NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: import.meta.dirname,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim(),
        catch: () => refuse("tool-commit-unavailable"),
      }));
    if (!/^[a-f0-9]{40}$/.test(commit)) return yield* refuse("tool-commit-unavailable");
    if (!completed)
      yield* runAllMigrations({ offlineDataMove: true }).pipe(
        Effect.mapError(() => refuse("migration-failed-discard-copy")),
      );
    const report = yield* verifyMoved(filename, neutral);
    if (!completed) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe(bridgeDefinition);
          yield* sql`INSERT INTO styal_data_move VALUES(1,1,${DateTime.formatIso(DateTime.nowUnsafe())},${commit},${neutral.mode},${neutral.digest})`;
        }),
      );
    }
    return { ...report, completed: true };
  }).pipe(
    Effect.provide(connection(filename, verify)),
    Effect.mapError((error) =>
      isRefusal(error) ? error : refuse("migration-validation-failed-discard-copy"),
    ),
  );
});
