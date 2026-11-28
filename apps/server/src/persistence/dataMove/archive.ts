// @effect-diagnostics nodeBuiltinImport:off - Standalone offline maintenance boundary.
// @effect-diagnostics globalJsonInEffect:off - Only archive metadata is encoded; source text stays in SQLite.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { archiveCell, assertOffline, PreflightRefusal, scanPreflight } from "./preflight.ts";
import { archiveInventory as inventory } from "./archiveInventory.ts";
import source from "./source.json" with { type: "json" };

const cellsTable = "styal_archive_raw_cells";
const manifestTable = "styal_archive_raw_manifest";
// BLOB affinity preserves every storage class; backfills read typeof(raw_text) and CAST(raw_text AS BLOB).
const definitions = [
  `CREATE TABLE ${cellsTable} (
    source_table TEXT NOT NULL,
    primary_key_json TEXT NOT NULL,
    column_name TEXT NOT NULL,
    raw_text BLOB NOT NULL,
    storage_class TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    upstream_version INTEGER NOT NULL,
    fork_version INTEGER NOT NULL,
    reasons_json TEXT NOT NULL,
    PRIMARY KEY (source_table, primary_key_json, column_name)
  ) WITHOUT ROWID`,
  `CREATE TABLE ${manifestTable} (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    format_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    tool_commit TEXT NOT NULL,
    upstream_version INTEGER NOT NULL,
    fork_version INTEGER NOT NULL,
    source_ledgers_json TEXT NOT NULL,
    counts_json TEXT NOT NULL,
    cells_sha256 TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL
  )`,
];
const q = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (name: string) => `'${name.replaceAll("'", "''")}'`;
const sha = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const refuse = (category: string) => new PreflightRefusal({ category });
// Typed hex text/blob and decimal numbers avoid JSON's integer rounding and preserve composite keys.
function primaryKey(columns: readonly { name: string; pk: number }[]) {
  const pk = columns.filter((column) => column.pk).sort((a, b) => a.pk - b.pk);
  if (!pk.length) throw refuse("source-primary-key-required");
  return `json_array(${pk
    .map(({ name }) => {
      const key = q(name);
      return `json_array(${literal(name)},typeof(${key}),CASE typeof(${key}) WHEN 'integer' THEN CAST(${key} AS TEXT) WHEN 'real' THEN printf('%!.26g',${key}) WHEN 'null' THEN NULL ELSE hex(CAST(${key} AS BLOB)) END)`;
    })
    .join(",")})`;
}
function keyBindings(key: string) {
  const parsed: unknown = JSON.parse(key);
  if (!Array.isArray(parsed) || !parsed.length) throw refuse("archive-key-invalid");
  const columns: string[] = [],
    bindings: string[] = [];
  const values: (string | Uint8Array | null)[] = [];
  for (const part of parsed) {
    if (
      !Array.isArray(part) ||
      part.length !== 3 ||
      typeof part[0] !== "string" ||
      !["integer", "real", "text", "blob", "null"].includes(part[1]) ||
      (typeof part[2] !== "string" && part[2] !== null)
    )
      throw refuse("archive-key-invalid");
    const [name, type, value] = part as [string, string, string | null];
    columns.push(q(name));
    bindings.push(
      type === "integer"
        ? "CAST(? AS INTEGER)"
        : type === "real"
          ? "CAST(? AS REAL)"
          : type === "text"
            ? "CAST(? AS TEXT)"
            : "?",
    );
    values.push(type === "text" || type === "blob" ? Buffer.from(value!, "hex") : value);
  }
  return {
    names: parsed.map((part: [string, string, string | null]) => part[0]),
    columns: `(${columns.join(",")})`,
    bindings: `(${bindings.join(",")})`,
    values,
  };
}
type Totals = Record<string, { cells: number; bytes: number }>;
function count(totals: Totals, key: string, bytes: number) {
  const total = (totals[key] ??= { cells: 0, bytes: 0 });
  total.cells++;
  total.bytes += bytes;
}
const scanCells = Effect.fn("DataMove.scanArchiveCells")(function* (
  visit: (cell: {
    table: string;
    column: string;
    key: string;
    bytes: Uint8Array;
    storageClass: string;
    reasons: ReturnType<typeof archiveCell>;
  }) => Effect.Effect<void, PreflightRefusal | import("effect/sql/SqlError").SqlError>,
) {
  const sql = yield* SqlClient.SqlClient;
  const encoding = (yield* sql.unsafe<{ encoding: string }>("PRAGMA encoding"))[0]!.encoding;
  for (const { table, column, record, codec, preserve } of inventory) {
    const columns = yield* sql.unsafe<{ name: string; pk: number }>(
      `PRAGMA table_info(${q(table)})`,
    );
    if (!columns.some((c) => c.name === column)) continue;
    const keySql = primaryKey(columns);
    const [kind] = yield* sql.unsafe<{ wr: number }>(
      "SELECT wr FROM pragma_table_list WHERE schema='main' AND name=?",
      [table],
    );
    const withoutRowid = kind?.wr === 1;
    const order = withoutRowid
      ? columns
          .filter((column) => column.pk)
          .sort((a, b) => a.pk - b.pk)
          .map((column) => q(column.name))
          .join(",")
      : "rowid";
    let cursor: string | undefined;
    for (;;) {
      const after =
        cursor === undefined ? undefined : withoutRowid ? keyBindings(cursor) : undefined;
      const rows = yield* sql.unsafe<{
        key: string;
        bytes: Uint8Array;
        text: string;
        storage_class: string;
        cursor: string;
      }>(
        `SELECT ${keySql} AS key, CAST(${q(column)} AS BLOB) AS bytes, CAST(${q(column)} AS TEXT) AS text, typeof(${q(column)}) AS storage_class, ${withoutRowid ? keySql : "CAST(rowid AS TEXT)"} AS cursor FROM ${q(table)} WHERE ${q(column)} IS NOT NULL ${cursor === undefined ? "" : withoutRowid ? `AND ${after!.columns}>${after!.bindings}` : "AND rowid>CAST(? AS INTEGER)"} ORDER BY ${order} LIMIT 128`,
        cursor === undefined ? [] : withoutRowid ? after!.values : [cursor],
      );
      for (const row of rows) {
        const reasons = archiveCell(codec, row.text, record, {
          bytes: row.bytes,
          storageClass: row.storage_class,
          encoding,
        });
        if (preserve) reasons.kinds.push("source-may-be-rewritten");
        if (reasons.kinds.length)
          yield* visit({
            table,
            column,
            key: row.key,
            bytes: row.bytes,
            storageClass: row.storage_class,
            reasons,
          });
      }
      if (rows.length < 128) break;
      cursor = rows.at(-1)!.cursor;
    }
  }
});

const validateArchive = Effect.fn("DataMove.validateArchive")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const objects = yield* sql<{
    name: string;
    sql: string;
  }>`SELECT name,sql FROM sqlite_schema WHERE name IN (${cellsTable},${manifestTable}) OR tbl_name IN (${cellsTable},${manifestTable})`;
  if (objects.length === 0) return false;
  if (
    objects.length !== 2 ||
    definitions.some(
      (definition, i) =>
        objects.find((object) => object.name === [cellsTable, manifestTable][i])?.sql !==
        definition,
    )
  )
    return yield* refuse("partial-or-mismatched-archive");
  return true;
});

const reasonKinds = new Set([
  "unknown-field",
  "reader-rejected",
  "retired-project-scripts",
  "reader-adapted",
  "stored-json-differs",
  "non-text-storage",
  "no-reader",
  "invalid-json",
  "source-may-be-rewritten",
]);
const archiveDigest = Effect.fn("DataMove.archiveDigest")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const totals: Totals = {};
  const kinds: Totals = {};
  const digest = NodeCrypto.createHash("sha256");
  let cursor: readonly string[] | undefined;
  for (;;) {
    const rows = yield* sql.unsafe<{
      source_table: string;
      primary_key_json: string;
      column_name: string;
      bytes: Uint8Array;
      byte_length: number;
      sha256: string;
      upstream_version: number;
      fork_version: number;
      reasons_json: string;
      storage_class: string;
      actual_class: string;
    }>(
      `SELECT *,CAST(raw_text AS BLOB) AS bytes,typeof(raw_text) AS actual_class FROM ${cellsTable} ${cursor ? "WHERE (source_table,primary_key_json,column_name)>(?,?,?)" : ""} ORDER BY source_table,primary_key_json,column_name LIMIT 128`,
      cursor,
    );
    for (const row of rows) {
      if (
        row.storage_class !== row.actual_class ||
        row.byte_length !== row.bytes.byteLength ||
        row.sha256 !== sha(row.bytes) ||
        row.upstream_version !== 86 ||
        row.fork_version !== 16
      )
        return yield* refuse("archive-integrity-mismatch");
      const reasons: unknown = yield* Effect.try({
        try: () => JSON.parse(row.reasons_json),
        catch: () => refuse("archive-reasons-invalid"),
      });
      if (
        typeof reasons !== "object" ||
        reasons === null ||
        !("kinds" in reasons) ||
        !Array.isArray(reasons.kinds)
      )
        return yield* refuse("archive-reasons-invalid");
      for (const kind of reasons.kinds) {
        if (typeof kind !== "string" || !reasonKinds.has(kind))
          return yield* refuse("archive-reasons-invalid");
        count(kinds, kind, row.byte_length);
      }
      count(totals, row.source_table, row.byte_length);
      digest.update(
        JSON.stringify([
          row.source_table,
          row.primary_key_json,
          row.column_name,
          row.byte_length,
          row.sha256,
          row.upstream_version,
          row.fork_version,
          row.reasons_json,
          row.storage_class,
        ]) + "\n",
      );
    }
    if (rows.length < 128) break;
    const last = rows.at(-1)!;
    cursor = [last.source_table, last.primary_key_json, last.column_name];
  }
  return { totals, kinds, digest: digest.digest("hex") };
});
const ledgers = JSON.stringify({ upstream: source.ledger, fork: source.forkLedger });
const manifestDigest = (row: {
  format_version: number;
  created_at: string;
  tool_commit: string;
  upstream_version: number;
  fork_version: number;
  source_ledgers_json: string;
  counts_json: string;
  cells_sha256: string;
}) =>
  sha(
    JSON.stringify([
      row.format_version,
      row.created_at,
      row.tool_commit,
      row.upstream_version,
      row.fork_version,
      row.source_ledgers_json,
      row.counts_json,
      row.cells_sha256,
    ]),
  );

const verifyArchive = Effect.fn("DataMove.verifyArchive")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const contents = yield* archiveDigest();
  const manifests = yield* sql.unsafe<{
    format_version: number;
    created_at: string;
    tool_commit: string;
    upstream_version: number;
    fork_version: number;
    source_ledgers_json: string;
    counts_json: string;
    cells_sha256: string;
    manifest_sha256: string;
  }>(`SELECT * FROM ${manifestTable}`);
  const manifest = manifests[0];
  if (
    manifests.length !== 1 ||
    !manifest ||
    manifest.format_version !== 2 ||
    manifest.upstream_version !== 86 ||
    manifest.fork_version !== 16 ||
    manifest.source_ledgers_json !== ledgers ||
    manifest.counts_json !== JSON.stringify(contents.totals) ||
    manifest.cells_sha256 !== contents.digest ||
    manifest.manifest_sha256 !== manifestDigest(manifest)
  )
    return yield* refuse("partial-or-mismatched-archive");
  let sourceStillMatches = true;
  // Check every archived cell, even if today's detector no longer selects it.
  let cursor: readonly string[] | undefined;
  for (;;) {
    const cells = yield* sql.unsafe<{
      source_table: string;
      primary_key_json: string;
      column_name: string;
      sha256: string;
      storage_class: string;
    }>(
      `SELECT source_table,primary_key_json,column_name,sha256,storage_class FROM ${cellsTable} ${cursor ? "WHERE (source_table,primary_key_json,column_name)>(?,?,?)" : ""} ORDER BY source_table,primary_key_json,column_name LIMIT 128`,
      cursor,
    );
    for (const cell of cells) {
      const item = inventory.find(
        (item) => item.table === cell.source_table && item.column === cell.column_name,
      );
      if (!item) return yield* refuse("archive-inventory-mismatch");
      const columns = yield* sql.unsafe<{ name: string; pk: number }>(
        `PRAGMA table_info(${q(item.table)})`,
      );
      if (!columns.some((column) => column.name === item.column)) {
        sourceStillMatches = false;
        continue;
      }
      const key = keyBindings(cell.primary_key_json);
      if (key.names.some((name) => !columns.some((column) => column.name === name))) {
        sourceStillMatches = false;
        continue;
      }
      const rows = yield* sql.unsafe<{ bytes: Uint8Array | null; storage_class: string }>(
        `SELECT CAST(${q(item.column)} AS BLOB) AS bytes,typeof(${q(item.column)}) AS storage_class FROM ${q(item.table)} WHERE ${key.columns} IS ${key.bindings}`,
        key.values,
      );
      if (
        rows.length !== 1 ||
        !rows[0]!.bytes ||
        rows[0]!.storage_class !== cell.storage_class ||
        sha(rows[0]!.bytes) !== cell.sha256
      )
        sourceStillMatches = false;
    }
    if (cells.length < 128) break;
    const last = cells.at(-1)!;
    cursor = [last.source_table, last.primary_key_json, last.column_name];
  }
  const census = yield* scanPreflight(undefined, [cellsTable, manifestTable], true);
  const atSourceSchema =
    Object.keys(census.schema).length === 0 &&
    Object.values(census.ledgers).every(
      (ledger) => ledger.missing.length + ledger.extra.length + ledger.renamed.length === 0,
    );
  let missingSelectedCells: number | null = atSourceSchema ? 0 : null;
  const kinds: Totals = {};
  const fields: Record<string, number> = {};
  if (atSourceSchema)
    yield* scanCells((cell) =>
      Effect.gen(function* () {
        for (const kind of cell.reasons.kinds) count(kinds, kind, cell.bytes.byteLength);
        for (const field of cell.reasons.fields)
          fields[`${cell.table}.${cell.column} / ${field}`] =
            (fields[`${cell.table}.${cell.column} / ${field}`] ?? 0) + 1;
        const rows = yield* sql.unsafe(
          `SELECT 1 FROM ${cellsTable} WHERE source_table=? AND primary_key_json=? AND column_name=?`,
          [cell.table, cell.key, cell.column],
        );
        if (!rows.length) missingSelectedCells = (missingSelectedCells ?? 0) + 1;
      }),
    );
  return {
    archiveIntact: true,
    sourceStillMatches,
    sourceComparison: sourceStillMatches
      ? "Archived source cells still match."
      : "Archived source cells changed or were removed; expected after neutralisation or migration.",
    missingSelectedCells,
    selectionCoverage: atSourceSchema ? "source-schema" : "not-applicable-source-schema-changed",
    tables: contents.totals,
    kinds: contents.kinds,
    currentSelectionKinds: atSourceSchema ? kinds : null,
    fields: atSourceSchema ? fields : null,
    sourceSchema: { upstream: 86, fork: 16 },
  };
});

export const archive = Effect.fn("DataMove.archive")(function* (path: string, verify = false) {
  const filename = yield* Effect.sync(() => {
    const file = assertOffline(path);
    for (const suffix of ["-wal", "-shm", "-journal"]) assertOffline(file + suffix);
    if (!NodeFS.existsSync(file)) throw refuse("existing-database-required");
    return file;
  });
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA busy_timeout=0`;
    yield* sql`PRAGMA trusted_schema=OFF`;
    if (!verify) yield* sql`PRAGMA locking_mode=EXCLUSIVE`;
    yield* sql.unsafe(verify ? "BEGIN" : "BEGIN EXCLUSIVE");
    return yield* Effect.gen(function* () {
      const exists = yield* validateArchive();
      if (verify && !exists) return yield* refuse("archive-missing");
      if (!verify) {
        if (exists) {
          const result = yield* verifyArchive();
          if (!result.sourceStillMatches || result.missingSelectedCells !== 0)
            return yield* refuse("archive-source-mismatch");
        }
        const census = yield* scanPreflight(undefined, exists ? [cellsTable, manifestTable] : []);
        if (census.verdict !== "ready") return yield* refuse("source-preflight-not-ready");
        if (!exists) {
          for (const definition of definitions) yield* sql.unsafe(definition);
          yield* scanCells((cell) =>
            Effect.gen(function* () {
              const key = keyBindings(cell.key);
              const [matched] = yield* sql.unsafe<{ n: number }>(
                `SELECT count(*) AS n FROM ${q(cell.table)} WHERE ${key.columns} IS ${key.bindings}`,
                key.values,
              );
              if (matched?.n !== 1) return yield* refuse("source-primary-key-not-unique");
              yield* sql.unsafe(
                `INSERT INTO ${cellsTable} SELECT ?,?,?,${q(cell.column)},?,?,?,86,16,? FROM ${q(cell.table)} WHERE ${key.columns} IS ${key.bindings}`,
                [
                  cell.table,
                  cell.key,
                  cell.column,
                  cell.storageClass,
                  cell.bytes.byteLength,
                  sha(cell.bytes),
                  JSON.stringify(cell.reasons),
                  ...key.values,
                ],
              );
            }),
          );
          const contents = yield* archiveDigest();
          const commit = yield* Effect.try({
            try: () =>
              NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
                cwd: import.meta.dirname,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
              }).trim(),
            catch: () => refuse("tool-revision-unavailable"),
          }).pipe(Effect.orElseSucceed(() => "unavailable"));
          const manifest = {
            format_version: 2,
            created_at: DateTime.formatIso(yield* DateTime.now),
            tool_commit: commit,
            upstream_version: 86,
            fork_version: 16,
            source_ledgers_json: ledgers,
            counts_json: JSON.stringify(contents.totals),
            cells_sha256: contents.digest,
          };
          yield* sql.unsafe(`INSERT INTO ${manifestTable} VALUES (1,?,?,?,?,?,?,?,?,?)`, [
            manifest.format_version,
            manifest.created_at,
            manifest.tool_commit,
            86,
            16,
            ledgers,
            manifest.counts_json,
            manifest.cells_sha256,
            manifestDigest(manifest),
          ]);
        }
      }
      const result = yield* verifyArchive();
      yield* sql.unsafe(verify ? "ROLLBACK" : "COMMIT");
      return result;
    }).pipe(Effect.onExit(() => sql.unsafe("ROLLBACK").pipe(Effect.ignore)));
  }).pipe(
    Effect.provide(
      Layer.merge(
        NodeSqliteClient.layer({
          filename: NodeURL.pathToFileURL(filename).href + (verify ? "?mode=ro" : "?mode=rw"),
          readonly: verify,
          readerWorker: false,
          writerWorker: false,
        }),
        Logger.layer([], { mergeWithExisting: false }),
      ),
    ),
    Effect.scoped,
    Effect.catchTags({ SqlError: () => Effect.fail(refuse("database-unavailable-or-busy")) }),
  );
});
