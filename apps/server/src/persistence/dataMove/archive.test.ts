// @effect-diagnostics nodeBuiltinImport:off - Synthetic offline SQLite and CLI tests.
// @effect-diagnostics globalJsonInEffect:off - Synthetic fixture inspection.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeZlib from "node:zlib";
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runAllMigrations } from "../ForkMigrations.ts";
import { archive } from "./archive.ts";
import { archiveCell } from "./preflight.ts";
import { columnCodecs, projectionCodecs } from "./codecs.ts";
import { archiveInventory, leftInPlace } from "./archiveInventory.ts";
import source from "./source.json" with { type: "json" };

const encodeNode = Schema.encodeUnknownSync(projectionCodecs.nodes);
const decodeNode = Schema.decodeUnknownSync(projectionCodecs.nodes);
const encodeProviderThread = Schema.encodeUnknownSync(projectionCodecs.provider_threads);
const decodeProviderThread = Schema.decodeUnknownSync(projectionCodecs.provider_threads);

const poison = "SYNTHETIC_ARCHIVE_POISON_NEVER_PRINT";
const q = (name: string) => `"${name.replaceAll('"', '""')}"`;
function fixture<A, E, R>(run: (file: string) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const dir = NodeFS.mkdtempSync("/tmp/styal-raw-archive-");
      const file = NodePath.join(dir, "source.sqlite");
      NodeFS.writeFileSync(
        file,
        NodeZlib.gunzipSync(
          NodeFS.readFileSync(NodePath.join(import.meta.dirname, "fixtures/preflight.sqlite.gz")),
        ),
      );
      edit(file, (db) => {
        db.exec(`INSERT INTO provider_session_runtime (thread_id,provider_name,adapter_key,runtime_mode,status,last_seen_at,resume_cursor_json,runtime_payload_json,provider_instance_id)
          SELECT 'ordinary','codex','synthetic','full-access','ready','2026-01-01T00:00:00.000Z','{}','{}','codex' WHERE NOT EXISTS(SELECT 1 FROM provider_session_runtime);
          INSERT INTO scheduled_task_webhook_deliveries (delivery_id,task_id,received_at,method,query,headers_json,body,body_bytes,body_truncated,outcome,signature_verified,missing_fields_json)
          SELECT 'synthetic-delivery','synthetic-task','2026-01-01T00:00:00.000Z','POST','','{}','{}',2,0,'accepted',0,'[]' WHERE NOT EXISTS(SELECT 1 FROM scheduled_task_webhook_deliveries);
          INSERT INTO mcp_app_model_context (thread_id,item_id,server,tool,text,updated_at)
          VALUES ('ordinary','synthetic-item','synthetic-server','synthetic-tool','{}','2026-01-01T00:00:00.000Z');`);
      });
      return { dir, file };
    }),
    ({ file }) => run(file),
    ({ dir }) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );
}
function edit(file: string, run: (db: NodeSqlite.DatabaseSync) => void) {
  const db = new NodeSqlite.DatabaseSync(file);
  try {
    run(db);
  } finally {
    db.close();
  }
}
const expectRefusal = Effect.fn("ArchiveTest.expectRefusal")(function* (
  file: string,
  category: string,
  verify = false,
) {
  const result = yield* Effect.result(archive(file, verify));
  expect(Result.isFailure(result) ? result.failure.category : "success").toBe(category);
});
function hashSource(file: string) {
  const hash = NodeCrypto.createHash("sha256");
  edit(file, (db) => {
    for (const table of source.definitions.filter((d) => d.type === "table")) {
      if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table.name))
        continue;
      const stmt = db.prepare(`SELECT * FROM ${q(table.name)}`);
      stmt.setReadBigInts(true);
      hash.update(
        JSON.stringify(stmt.all(), (_, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      );
    }
  });
  return hash.digest("hex");
}
it.effect(
  "archives selected witnesses byte-exactly, leaves sources untouched and repeats without writes",
  () =>
    fixture((file) =>
      Effect.gen(function* () {
        edit(file, (db) => {
          // A known removed field admits duplicate keys, unusual formatting, non-ASCII and a large value.
          const row = db
            .prepare("SELECT payload_json FROM orchestration_v2_projection_messages LIMIT 1")
            .get()!;
          const text = String(row.payload_json);
          const raw =
            '{\n "report": {"answer": "first", "answer": "雪🧵' +
            "x".repeat(200_000) +
            '"},\t' +
            text.slice(1);
          db.prepare(
            "UPDATE orchestration_v2_projection_messages SET payload_json=? WHERE rowid=(SELECT rowid FROM orchestration_v2_projection_messages LIMIT 1)",
          ).run(raw);
          db.prepare("UPDATE projection_projects SET scripts_json=?").run(
            JSON.stringify([
              {
                id: "synthetic-script",
                name: poison,
                command: poison,
                icon: "desktop",
                runOnWorktreeCreate: false,
              },
            ]),
          );
        });
        edit(file, (db) =>
          db.exec(
            "UPDATE projection_thread_pull_requests SET snapshot_json=json_set(snapshot_json, '$.autoMergeEnabled', 1)",
          ),
        );
        edit(file, (db) => {
          db.prepare("UPDATE projection_thread_pull_requests SET host=?").run(
            "synthetic\u0000雪'host",
          );
          db.exec("UPDATE auth_sessions SET scopes=json_insert(scopes, '$[#]', 'devices:operate')");
        });
        edit(file, (db) => {
          const census = JSON.parse(
            NodeZlib.gunzipSync(
              NodeFS.readFileSync(new URL("./fixtures/compatibility.json.gz", import.meta.url)),
            ).toString(),
          ) as { shapes: { name: string; value: unknown }[] };
          const context = census.shapes.find(
            (shape) =>
              shape.name === "column.OrchestrationMessageContext" &&
              JSON.stringify(shape.value).includes('"contextId":'),
          );
          expect(context).toBeDefined();
          db.prepare("UPDATE projection_thread_messages SET context_json=?").run(
            JSON.stringify(context!.value, null, 2),
          );
        });
        const before = hashSource(file);
        const report = yield* archive(file);
        expect(report.archiveIntact).toBe(true);
        expect(report.sourceStillMatches).toBe(true);
        expect(report.missingSelectedCells).toBe(0);
        expect(hashSource(file)).toBe(before);
        edit(file, (db) => {
          const archiveRows = db
            .prepare("SELECT *,CAST(raw_text AS BLOB) bytes FROM styal_archive_raw_cells")
            .all();
          expect(archiveRows.length).toBeGreaterThan(0);
          for (const row of archiveRows) {
            const key = JSON.parse(String(row.primary_key_json)) as [string, string, string][];
            expect(key.length).toBeGreaterThan(0);
            const predicate = key
              .map(([name, type]) =>
                type === "text" || type === "blob"
                  ? `hex(CAST(${q(name)} AS BLOB))=?`
                  : `CAST(${q(name)} AS TEXT)=?`,
              )
              .join(" AND ");
            const raw = db
              .prepare(
                `SELECT CAST(${q(String(row.column_name))} AS BLOB) bytes FROM ${q(String(row.source_table))} WHERE ${predicate}`,
              )
              .get(...key.map(([, , value]) => value));
            expect(Buffer.from(row.bytes as Uint8Array)).toEqual(
              Buffer.from(raw!.bytes as Uint8Array),
            );
          }
          expect(archiveRows.some((r) => JSON.parse(String(r.primary_key_json)).length > 1)).toBe(
            true,
          );
          for (const [table, column] of [
            ["orchestration_v2_projection_messages", "payload_json"],
            ["projection_projects", "scripts_json"],
            ["projection_thread_pull_requests", "snapshot_json"],
            ["projection_thread_messages", "context_json"],
            ["auth_sessions", "scopes"],
          ])
            expect(
              archiveRows.some(
                (cell) => cell.source_table === table && cell.column_name === column,
              ),
            ).toBe(true);
        });
        const bytes = NodeFS.readFileSync(file);
        const second = yield* archive(file);
        expect(second).toEqual(report);
        expect(NodeFS.readFileSync(file)).toEqual(bytes);
        expect(JSON.stringify(report)).not.toContain(poison);
        expect(yield* archive(file, true)).toEqual(report);
      }),
    ),
);

it.effect(
  "refuses partial archives, bad ledgers and preflight failures without adding archive data",
  () =>
    fixture((file) =>
      Effect.gen(function* () {
        const before = hashSource(file);
        edit(file, (db) => db.exec("CREATE TABLE styal_archive_raw_cells (partial TEXT)"));
        yield* expectRefusal(file, "partial-or-mismatched-archive");
        expect(hashSource(file)).toBe(before);
        edit(file, (db) =>
          db.exec(
            "DROP TABLE styal_archive_raw_cells; DELETE FROM effect_sql_migrations WHERE migration_id=86",
          ),
        );
        yield* expectRefusal(file, "source-preflight-not-ready");
        edit(file, (db) =>
          expect(
            db
              .prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'styal_archive_%'")
              .get()!.n,
          ).toBe(0),
        );
      }),
    ),
);

it.effect(
  "distinguishes intact archives from changed/deleted sources and missing selected cells",
  () =>
    fixture((file) =>
      Effect.gen(function* () {
        yield* archive(file);
        edit(file, (db) => db.exec("DELETE FROM orchestration_v2_projection_messages"));
        const deleted = yield* archive(file, true);
        expect(deleted.archiveIntact).toBe(true);
        expect(deleted.sourceStillMatches).toBe(false);
        edit(file, (db) =>
          db.exec(
            "INSERT INTO orchestration_v2_projection_plans SELECT 'synthetic-new-plan',thread_id,run_id,node_id,kind,status,'{' FROM orchestration_v2_projection_plans LIMIT 1",
          ),
        );
        const changed = yield* archive(file, true);
        expect(changed.archiveIntact).toBe(true);
        expect(changed.missingSelectedCells).toBeGreaterThan(0);
        const cli = NodeChildProcess.spawnSync(
          process.execPath,
          [NodePath.join(import.meta.dirname, "archiveCli.ts"), file, "--verify"],
          { encoding: "utf8" },
        );
        expect(cli.status).toBe(1);
        expect(JSON.parse(cli.stdout).archiveIntact).toBe(true);
        yield* expectRefusal(file, "archive-source-mismatch");
      }),
    ),
);

it.effect("detects tampered archive payloads", () =>
  fixture((file) =>
    Effect.gen(function* () {
      yield* archive(file);
      edit(file, (db) =>
        db.exec(
          "UPDATE styal_archive_raw_cells SET raw_text='tampered' WHERE source_table=(SELECT source_table FROM styal_archive_raw_cells LIMIT 1)",
        ),
      );
      yield* expectRefusal(file, "archive-integrity-mismatch", true);
    }),
  ),
);

it.effect(
  "selects unparseable/rejected cells and each historical adapter, but initial corruption fails preflight",
  () =>
    fixture((file) =>
      Effect.gen(function* () {
        expect(archiveCell(projectionCodecs.messages, "{", "messages").kinds).toContain(
          "invalid-json",
        );
        expect(archiveCell(projectionCodecs.messages, "{}", "messages").kinds).toContain(
          "reader-rejected",
        );
        expect(
          archiveCell(
            columnCodecs["auth_sessions.scopes"],
            '["devices:operate"]',
            "auth_sessions.scopes",
          ).kinds,
        ).toContain("reader-adapted");
        edit(file, (db) =>
          db.exec("UPDATE orchestration_v2_projection_plans SET payload_json='{'"),
        );
        yield* expectRefusal(file, "source-preflight-not-ready");
      }),
    ),
);

it.effect("refuses an active SQLite reader and does not write an archive", () =>
  fixture((file) =>
    Effect.gen(function* () {
      const db = new NodeSqlite.DatabaseSync(file);
      try {
        db.exec("BEGIN; SELECT * FROM orchestration_v2_projection_threads");
        yield* expectRefusal(file, "database-unavailable-or-busy");
      } finally {
        db.exec("ROLLBACK");
        db.close();
      }
    }),
  ),
);

it.effect(
  "CLI reports no values, IDs or paths on success or failure and keeps the live-home guard",
  () =>
    fixture((file) =>
      Effect.gen(function* () {
        const result = NodeChildProcess.spawnSync(
          process.execPath,
          [NodePath.join(import.meta.dirname, "archiveCli.ts"), file],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              T3CODE_TELEMETRY_ENABLED: "false",
              DO_NOT_TRACK: "1",
              T3CODE_ERROR_REPORTING_ENABLED: "false",
            },
          },
        );
        expect(result.status).toBe(0);
        expect(result.stdout + result.stderr).not.toContain(file);
        expect(result.stdout + result.stderr).not.toContain("ordinary");
        expect(result.stdout + result.stderr).not.toContain("SYNTHETIC_");
        for (const verify of [false, true]) {
          const guarded = NodeChildProcess.spawnSync(
            process.execPath,
            [
              NodePath.join(import.meta.dirname, "archiveCli.ts"),
              NodePath.join(NodeOS.homedir(), ".styal", "synthetic.sqlite"),
              ...(verify ? ["--verify"] : []),
            ],
            { encoding: "utf8" },
          );
          expect(guarded.status).toBe(1);
          expect(JSON.parse(guarded.stderr)).toEqual({ refused: "live-styal-home-refused" });
        }
        edit(file, (db) => db.exec("DELETE FROM orchestration_v2_projection_messages"));
        const changed = NodeChildProcess.spawnSync(
          process.execPath,
          [NodePath.join(import.meta.dirname, "archiveCli.ts"), file, "--verify"],
          { encoding: "utf8" },
        );
        expect(changed.status).toBe(0);
        expect(JSON.parse(changed.stdout)).toMatchObject({
          archiveIntact: true,
          sourceStillMatches: false,
        });
        expect(JSON.parse(changed.stdout).sourceComparison).toContain(
          "expected after neutralisation or migration",
        );
        const bad = NodeChildProcess.spawnSync(
          process.execPath,
          [NodePath.join(import.meta.dirname, "archiveCli.ts"), file + poison],
          { encoding: "utf8" },
        );
        expect(bad.status).toBe(1);
        expect(JSON.parse(bad.stderr)).toEqual({ refused: "existing-database-required" });
        expect(bad.stdout + bad.stderr).not.toContain(poison);
        yield* Effect.void;
      }),
    ),
);

it.effect(
  "archive survives upstream 87–117, fork migrations, compaction and a whole-database snapshot",
  () =>
    fixture((file) =>
      Effect.gen(function* () {
        const before = yield* archive(file);
        yield* runAllMigrations({ offlineDataMove: true }).pipe(
          Effect.provide(
            NodeSqliteClient.layer({ filename: file, readerWorker: false, writerWorker: false }),
          ),
        );
        const migrated = yield* archive(file, true);
        expect(migrated.archiveIntact).toBe(true);
        expect(migrated.tables).toEqual(before.tables);
        expect(migrated.missingSelectedCells).toBeNull();
        expect(migrated.selectionCoverage).toBe("not-applicable-source-schema-changed");
        const snapshot = NodePath.join(NodePath.dirname(file), "snapshot.sqlite");
        edit(file, (db) => {
          db.exec("PRAGMA auto_vacuum=INCREMENTAL; VACUUM; PRAGMA incremental_vacuum(1)");
          db.prepare("VACUUM INTO ?").run(snapshot);
        });
        expect((yield* archive(snapshot, true)).tables).toEqual(before.tables);
      }),
    ),
);

it.effect("valid modern scripts are archived even though the script codec accepts them", () =>
  fixture((file) =>
    Effect.gen(function* () {
      edit(file, (db) =>
        db.prepare("UPDATE projection_projects SET scripts_json=?").run(
          JSON.stringify([
            {
              id: "synthetic-script",
              name: poison,
              command: poison,
              icon: "play",
              runOnWorktreeCreate: false,
            },
          ]),
        ),
      );
      const report = yield* archive(file);
      expect(report.kinds["retired-project-scripts"]!.cells).toBeGreaterThan(0);
      edit(file, (db) => {
        const count = db
          .prepare("SELECT count(*) n FROM projection_projects WHERE scripts_json IS NOT NULL")
          .get()!.n;
        expect(
          db
            .prepare(
              "SELECT count(*) n FROM styal_archive_raw_cells WHERE source_table='projection_projects' AND column_name='scripts_json'",
            )
            .get()!.n,
        ).toBe(count);
      });
    }),
  ),
);

it.effect(
  "pages hundreds of source/archive cells without gaps and detects metadata or missing rows",
  () =>
    fixture((file) =>
      Effect.gen(function* () {
        edit(file, (db) => {
          const columns = db
            .prepare("PRAGMA table_info(projection_projects)")
            .all()
            .map((row) => String(row.name));
          const insert = db.prepare(
            `INSERT INTO projection_projects SELECT ${columns.map((name) => (name === "project_id" ? "?" : q(name))).join(",")} FROM projection_projects LIMIT 1`,
          );
          for (let i = 0; i < 260; i++) insert.run(`synthetic-page-${i}`);
        });
        const report = yield* archive(file);
        expect(report.tables.projection_projects!.cells).toBeGreaterThan(260);
        expect((yield* archive(file, true)).missingSelectedCells).toBe(0);
        edit(file, (db) => db.exec("UPDATE styal_archive_raw_manifest SET tool_commit='tampered'"));
        yield* expectRefusal(file, "partial-or-mismatched-archive", true);
      }),
    ),
);

it.effect(
  "archives every selected source projection witness from the compatibility generator",
  () =>
    fixture((file) =>
      Effect.gen(function* () {
        const census = JSON.parse(
          NodeZlib.gunzipSync(
            NodeFS.readFileSync(new URL("./fixtures/compatibility.json.gz", import.meta.url)),
          ).toString(),
        ) as { shapes: { name: string; value: Record<string, unknown> }[] };
        const names = [
          "AppThreadJson",
          "RunJson",
          "RunAttemptJson",
          "ExecutionNodeJson",
          "ProviderSessionJson",
          "ProviderThreadJson",
          "ProviderTurnJson",
          "RuntimeRequestJson",
          "ConversationMessageJson",
          "PlanArtifact",
          "TurnItemJson",
          "CheckpointScopeJson",
          "CheckpointJson",
          "ContextHandoffJson",
          "ContextTransferJson",
          "SubagentJson",
        ];
        const kinds = Object.keys(projectionCodecs);
        const expected: { table: string; key: string; text: string }[] = [];
        edit(file, (db) => {
          db.exec("BEGIN");
          let ordinal = 1000;
          for (const shape of census.shapes) {
            if (!shape.name.startsWith("projection.")) continue;
            const n = ++ordinal;
            const kind = kinds[names.indexOf(shape.name.slice(11))]!;
            const table = "orchestration_v2_projection_" + kind;
            const text = JSON.stringify(shape.value, null, 2);
            const row: Record<string, string | number | null> = {};
            for (const column of db.prepare(`PRAGMA table_info(${q(table)})`).all()) {
              const name = String(column.name);
              const camel = name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
              let value = column.pk
                ? `synthetic-witness-${n}`
                : name === "payload_json"
                  ? text
                  : name.endsWith("_id")
                    ? `synthetic-ref-${n}`
                    : name === "provider"
                      ? "codex"
                      : shape.value[camel];
              if (typeof value === "boolean") value = Number(value);
              if (value === undefined) {
                if (!column.notnull) value = null;
                else if (column.dflt_value !== null) continue;
                else value = column.type === "INTEGER" ? 1 : "synthetic";
              }
              if (value !== null && typeof value !== "string" && typeof value !== "number")
                throw new Error("Non-scalar synthetic column");
              row[name] = value;
            }
            db.prepare(
              `INSERT INTO ${q(table)} (${Object.keys(row).map(q).join(",")}) VALUES (${Object.keys(
                row,
              )
                .map(() => "?")
                .join(",")})`,
            ).run(...Object.values(row));
            // Expected selection comes from the raw fixture bytes: pretty JSON is not canonical JSON.
            expect(Buffer.from(text).equals(Buffer.from(JSON.stringify(JSON.parse(text))))).toBe(
              false,
            );
            expected.push({ table, key: `synthetic-witness-${n}`, text });
          }
          db.exec("COMMIT");
        });
        const before = hashSource(file);
        const report = yield* archive(file);
        expect(report.archiveIntact).toBe(true);
        expect(expected.length).toBeGreaterThan(100);
        expect(hashSource(file)).toBe(before);
        edit(file, (db) => {
          const find = db.prepare(
            "SELECT raw_text FROM styal_archive_raw_cells WHERE source_table=? AND primary_key_json=? AND column_name='payload_json'",
          );
          for (const witness of expected) {
            const definition = source.definitions.find((d) => d.name === witness.table)!;
            const pk = definition.columns.filter((c) => c.pk).sort((a, b) => a.pk - b.pk);
            const key = JSON.stringify(
              pk.map((column) => [
                column.name,
                "text",
                Buffer.from(witness.key).toString("hex").toUpperCase(),
              ]),
            );
            expect(find.get(witness.table, key)?.raw_text).toBe(witness.text);
          }
        });
      }),
    ),
);

it("accounts for every JSON/opaque source column and requires an audit when the pin changes", () => {
  const tables = source.definitions.filter((definition) => definition.type === "table");
  const shape = tables.map((table) => [
    table.name,
    table.columns.map((column) => [column.name, column.type]),
  ]);
  // Also catches future opaque columns without a JSON-looking name: re-pin only after auditing their writers.
  expect(NodeCrypto.createHash("sha256").update(JSON.stringify(shape)).digest("hex")).toBe(
    "496c2226b04a69714726c15023a59ea8fa0e1e065143c53fad9c633edadb5ddf",
  );
  const candidates = tables.flatMap((table) =>
    table.columns
      .filter(
        (column) =>
          /json|payload/.test(column.name) ||
          [
            "auth_sessions.scopes",
            "auth_pairing_links.scopes",
            "scheduled_task_webhook_deliveries.body",
            "mcp_app_model_context.text",
            "orchestration_command_receipts.error",
            "orchestration_v2_command_receipts.error",
          ].includes(`${table.name}.${column.name}`),
      )
      .map((column) => `${table.name}.${column.name}`),
  );
  expect(
    [
      ...archiveInventory.map((cell) => `${cell.table}.${cell.column}`),
      ...Object.keys(leftInPlace),
    ].sort(),
  ).toEqual(candidates.sort());
});

it.effect(
  "selects parse losses and non-TEXT storage for their specific reasons and preserves their bytes",
  () =>
    fixture((file) =>
      Effect.gen(function* () {
        const raws = [
          '{"a":"first","a":"second"}',
          '{"n":12345678901234567891}',
          '{"s":"\\u0061"}',
        ];
        expect(
          archiveCell(
            columnCodecs["scheduled_task_webhook_deliveries.headers_json"],
            raws[0]!,
            "scheduled_task_webhook_deliveries.headers_json",
          ).kinds,
        ).toEqual(["stored-json-differs"]);
        for (const text of raws.slice(1))
          expect(archiveCell(Schema.Unknown, text, "opaque").kinds).toEqual([
            "stored-json-differs",
          ]);
        const invalid = Buffer.from("7b2261223a22ff227d", "hex");
        expect(
          archiveCell(Schema.Unknown, invalid.toString(), "opaque", {
            bytes: invalid,
            storageClass: "text",
            encoding: "UTF-8",
          }).kinds,
        ).toEqual(["stored-json-differs"]);
        edit(file, (db) => {
          for (const expression of ["x'31'", "1", "1.25"]) {
            const row = db
              .prepare(
                `SELECT CAST(${expression} AS TEXT) text, CAST(${expression} AS BLOB) bytes, typeof(${expression}) storage_class`,
              )
              .get()!;
            expect(
              archiveCell(Schema.Unknown, String(row.text), "opaque", {
                bytes: row.bytes as Uint8Array,
                storageClass: String(row.storage_class),
                encoding: "UTF-8",
              }).kinds,
            ).toEqual(["non-text-storage"]);
          }
          const node = db
            .prepare("SELECT payload_json FROM orchestration_v2_projection_nodes LIMIT 1")
            .get()!;
          const canonical = encodeNode(decodeNode(JSON.parse(String(node.payload_json))));
          const duplicate = '{"id":"lost-original",' + JSON.stringify(canonical).slice(1);
          expect(archiveCell(projectionCodecs.nodes, duplicate, "nodes").kinds).toEqual([
            "stored-json-differs",
          ]);
          db.prepare(
            "UPDATE orchestration_v2_projection_nodes SET payload_json=? WHERE rowid=(SELECT rowid FROM orchestration_v2_projection_nodes LIMIT 1)",
          ).run(duplicate);
          db.prepare("UPDATE scheduled_task_webhook_deliveries SET headers_json=?").run(raws[0]!);
          db.prepare(
            "UPDATE provider_session_runtime SET resume_cursor_json=?, runtime_payload_json=CAST(? AS TEXT)",
          ).run(raws[1]!, invalid);
        });
        yield* archive(file);
        edit(file, (db) => {
          for (const [table, column, bytes] of [
            ["provider_session_runtime", "resume_cursor_json", Buffer.from(raws[1]!)],
            ["provider_session_runtime", "runtime_payload_json", invalid],
            ["scheduled_task_webhook_deliveries", "headers_json", Buffer.from(raws[0]!)],
          ] as const) {
            const archived = db
              .prepare(
                "SELECT CAST(raw_text AS BLOB) bytes, reasons_json FROM styal_archive_raw_cells WHERE source_table=? AND column_name=? LIMIT 1",
              )
              .get(table, column)!;
            expect(Buffer.from(archived.bytes as Uint8Array)).toEqual(bytes);
            expect(JSON.parse(String(archived.reasons_json)).kinds).toContain(
              "stored-json-differs",
            );
          }
        });
      }),
    ),
);

it.effect("archives a one-byte BLOB without coercion", () =>
  fixture((file) =>
    Effect.gen(function* () {
      edit(file, (db) => db.exec("UPDATE provider_session_runtime SET resume_cursor_json=x'31'"));
      const before = hashSource(file);
      yield* archive(file);
      expect(hashSource(file)).toBe(before);
      edit(file, (db) => {
        const cell = db
          .prepare(
            "SELECT typeof(raw_text) type, CAST(raw_text AS BLOB) bytes,reasons_json FROM styal_archive_raw_cells WHERE source_table='provider_session_runtime' AND column_name='resume_cursor_json' LIMIT 1",
          )
          .get()!;
        expect(cell.type).toBe("blob");
        expect(Buffer.from(cell.bytes as Uint8Array)).toEqual(Buffer.from([49]));
        expect(JSON.parse(String(cell.reasons_json)).kinds).toContain("non-text-storage");
        expect(JSON.parse(String(cell.reasons_json)).kinds).not.toContain("invalid-json");
      });
      expect((yield* archive(file, true)).sourceStillMatches).toBe(true);
    }),
  ),
);

it.effect("refuses ambiguous NULL primary keys explicitly and rolls back", () =>
  fixture((file) =>
    Effect.gen(function* () {
      edit(file, (db) => {
        const columns = db
          .prepare("PRAGMA table_info(auth_sessions)")
          .all()
          .map((column) => String(column.name));
        const copy = db.prepare(
          `INSERT INTO auth_sessions SELECT ${columns.map((name) => (name === "session_id" ? "NULL" : q(name))).join(",")} FROM auth_sessions LIMIT 1`,
        );
        copy.run();
        copy.run();
      });
      const before = hashSource(file);
      yield* expectRefusal(file, "source-primary-key-not-unique");
      expect(hashSource(file)).toBe(before);
      edit(file, (db) =>
        expect(
          db
            .prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'styal_archive_%'")
            .get()!.n,
        ).toBe(0),
      );
    }),
  ),
);

it.effect("detects a deleted archive row in both modes", () =>
  fixture((file) =>
    Effect.gen(function* () {
      yield* archive(file);
      edit(file, (db) =>
        db.exec(
          "DELETE FROM styal_archive_raw_cells WHERE (source_table,primary_key_json,column_name)=(SELECT source_table,primary_key_json,column_name FROM styal_archive_raw_cells LIMIT 1)",
        ),
      );
      yield* expectRefusal(file, "partial-or-mismatched-archive", true);
      yield* expectRefusal(file, "partial-or-mismatched-archive");
    }),
  ),
);

it.effect(
  "marks selection coverage not applicable after a source column is renamed or a table is gone",
  () =>
    fixture((file) =>
      Effect.gen(function* () {
        yield* archive(file);
        edit(file, (db) =>
          db.exec(
            "ALTER TABLE projection_projects RENAME COLUMN scripts_json TO retired_scripts_json; DROP TABLE provider_session_runtime",
          ),
        );
        const report = yield* archive(file, true);
        expect(report.archiveIntact).toBe(true);
        expect(report.sourceStillMatches).toBe(false);
        expect(report.missingSelectedCells).toBeNull();
        expect(report.selectionCoverage).toBe("not-applicable-source-schema-changed");
      }),
    ),
);

it.effect("keeps every no-reader payload and clean state that neutralisation can delete", () =>
  fixture((file) =>
    Effect.gen(function* () {
      yield* archive(file);
      edit(file, (db) => {
        for (const [table, column, reason] of [
          ["orchestration_v2_effect_outbox", "payload_json", "no-reader"],
          ["scheduled_task_webhook_deliveries", "body", "no-reader"],
          ["mcp_app_model_context", "text", "no-reader"],
          ["auth_sessions", "scopes", "source-may-be-rewritten"],
          ["provider_session_runtime", "resume_cursor_json", "source-may-be-rewritten"],
        ]) {
          const sourceRows = db
            .prepare(
              `SELECT CAST(${q(column!)} AS BLOB) bytes FROM ${q(table!)} WHERE ${q(column!)} IS NOT NULL`,
            )
            .all();
          const rows = db
            .prepare(
              "SELECT CAST(raw_text AS BLOB) bytes,reasons_json FROM styal_archive_raw_cells WHERE source_table=? AND column_name=?",
            )
            .all(table!, column!);
          expect(sourceRows.length).toBeGreaterThan(0);
          expect(rows.length).toBe(sourceRows.length);
          for (const row of rows) {
            expect(JSON.parse(String(row.reasons_json)).kinds).toContain(reason);
            expect(
              sourceRows.some((source) =>
                Buffer.from(source.bytes as Uint8Array).equals(row.bytes as Uint8Array),
              ),
            ).toBe(true);
          }
        }
      });
    }),
  ),
);

it.effect("keeps canonical background rosters before they are cleared", () =>
  fixture((file) =>
    Effect.gen(function* () {
      let raw = "";
      edit(file, (db) => {
        const first = db
          .prepare("SELECT payload_json FROM orchestration_v2_projection_provider_threads LIMIT 1")
          .get()!;
        const value = JSON.parse(String(first.payload_json));
        const task = {
          taskId: "synthetic-task",
          kind: "background_task",
          description: "Synthetic work",
        };
        const encoded = encodeProviderThread(
          decodeProviderThread({
            ...value,
            pendingBackgroundTasks: [task],
          }),
        );
        raw = JSON.stringify(encoded);
        expect(
          archiveCell(projectionCodecs.provider_threads, raw, "provider_threads").kinds,
        ).toEqual([]);
        db.prepare("UPDATE orchestration_v2_projection_provider_threads SET payload_json=?").run(
          raw,
        );
      });
      yield* archive(file);
      edit(file, (db) =>
        db.exec(
          "UPDATE orchestration_v2_projection_provider_threads SET payload_json=json_set(payload_json,'$.pendingBackgroundTasks',json('[]'))",
        ),
      );
      const report = yield* archive(file, true);
      expect(report.archiveIntact).toBe(true);
      expect(report.sourceStillMatches).toBe(false);
      edit(file, (db) => {
        const cells = db
          .prepare(
            "SELECT raw_text,reasons_json FROM styal_archive_raw_cells WHERE source_table='orchestration_v2_projection_provider_threads'",
          )
          .all();
        expect(
          cells.some(
            (cell) =>
              cell.raw_text === raw &&
              JSON.parse(String(cell.reasons_json)).kinds.includes("source-may-be-rewritten"),
          ),
        ).toBe(true);
      });
    }),
  ),
);

function encodedFixture(file: string, encoding: string) {
  const copy = NodePath.join(NodePath.dirname(file), `source-${encoding}.sqlite`);
  const original = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  const target = new NodeSqlite.DatabaseSync(copy);
  try {
    target.exec(`PRAGMA encoding='${encoding}'`);
    const objects = original
      .prepare("SELECT name,type,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid")
      .all();
    const shadow = new Set(
      original
        .prepare("SELECT name FROM pragma_table_list WHERE type='shadow'")
        .all()
        .map((row) => row.name),
    );
    const tables = objects.filter(
      (row) => row.type === "table" && row.name !== "sqlite_sequence" && !shadow.has(row.name),
    );
    for (const table of tables) target.exec(String(table.sql));
    for (const table of tables.filter((table) => !String(table.sql).startsWith("CREATE VIRTUAL"))) {
      const columns = original
        .prepare(`PRAGMA table_info(${q(String(table.name))})`)
        .all()
        .map((column) => String(column.name));
      const select = original.prepare(
        `SELECT ${columns.map(q).join(",")} FROM ${q(String(table.name))}`,
      );
      select.setReadBigInts(true);
      const insert = target.prepare(
        `INSERT INTO ${q(String(table.name))} (${columns.map(q).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      );
      for (const row of select.iterate()) insert.run(...columns.map((column) => row[column]!));
    }
    target.exec("DELETE FROM sqlite_sequence");
    for (const row of original.prepare("SELECT name,seq FROM sqlite_sequence").all())
      target.prepare("INSERT INTO sqlite_sequence VALUES (?,?)").run(row.name!, row.seq!);
    for (const object of objects.filter((row) => row.type !== "table" && !shadow.has(row.name)))
      target.exec(String(object.sql));
  } finally {
    target.close();
    original.close();
  }
  return copy;
}
it.effect("uses actual UTF-16LE and UTF-16BE source bytes for selection and hashing", () =>
  fixture((file) =>
    Effect.gen(function* () {
      for (const encoding of ["UTF-16le", "UTF-16be"]) {
        const copy = encodedFixture(file, encoding);
        edit(copy, (db) => {
          db.prepare(
            "UPDATE provider_session_runtime SET resume_cursor_json=?,runtime_payload_json=?",
          ).run('{"ok":"雪🧵"}', '{"n":12345678901234567891}');
        });
        yield* archive(copy);
        edit(copy, (db) => {
          const cells = db
            .prepare(
              "SELECT column_name,CAST(raw_text AS BLOB) bytes,reasons_json FROM styal_archive_raw_cells WHERE source_table='provider_session_runtime'",
            )
            .all();
          const canonical = cells.find((cell) => cell.column_name === "resume_cursor_json")!;
          expect(JSON.parse(String(canonical.reasons_json)).kinds).not.toContain(
            "stored-json-differs",
          );
          const lossy = cells.find((cell) => cell.column_name === "runtime_payload_json")!;
          expect(JSON.parse(String(lossy.reasons_json)).kinds).toContain("stored-json-differs");
          const source = db
            .prepare(
              "SELECT CAST(runtime_payload_json AS BLOB) bytes FROM provider_session_runtime LIMIT 1",
            )
            .get()!;
          expect(Buffer.from(lossy.bytes as Uint8Array)).toEqual(
            Buffer.from(source.bytes as Uint8Array),
          );
        });
        expect((yield* archive(copy, true)).sourceStillMatches).toBe(true);
      }
    }),
  ),
);
