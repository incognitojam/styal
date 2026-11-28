// @effect-diagnostics nodeBuiltinImport:off - Synthetic SQLite fixture and CLI boundary tests.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeModule from "node:module";
import * as NodeSqlite from "node:sqlite";
import * as NodeZlib from "node:zlib";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Contracts from "@t3tools/contracts";
import { ProjectDbRow } from "../../orchestration-v2/ProjectStore.ts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { projectionCodecs, columnCodecs } from "./codecs.ts";
import { assertOffline, preflight } from "./preflight.ts";
import source from "./source.json" with { type: "json" };

const decodeCensus = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      shapes: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.Unknown })),
    }),
  ),
);
const censusRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const censusScalar = Schema.decodeUnknownSync(
  Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
);

const fixtureVerdict =
  Object.hasOwn(Contracts.OrchestrationV2AppThread.fields, "forkHistoryMaterialized") &&
  Object.hasOwn(ProjectDbRow.fields, "additionalInstructions")
    ? "ready"
    : "unexpected";

const mutableOS = NodeModule.createRequire(import.meta.url)("node:os") as typeof NodeOS;

const scratch = NodePath.resolve(import.meta.dirname, "../../../../../.scratch");
function fixture<A, E, R>(
  run: (file: string, dir: string) => Effect.Effect<A, E, R>,
  family = "preflight",
) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      NodeFS.mkdirSync(scratch, { recursive: true });
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "styal-compat-preflight-"));
      const file = NodePath.join(dir, "source.sqlite");
      NodeFS.writeFileSync(
        file,
        NodeZlib.gunzipSync(
          NodeFS.readFileSync(NodePath.join(import.meta.dirname, `fixtures/${family}.sqlite.gz`)),
        ),
      );
      const info = NodeOS.userInfo();
      const originalHome = NodeOS.homedir,
        originalInfo = NodeOS.userInfo;
      mutableOS.homedir = () => NodePath.join(dir, "home");
      mutableOS.userInfo = (() => ({
        ...info,
        homedir: NodePath.join(dir, "home"),
      })) as typeof NodeOS.userInfo;
      NodeModule.syncBuiltinESMExports();
      return { file, dir, originalHome, originalInfo };
    }),
    ({ file, dir }) => run(file, dir),
    ({ dir, originalHome, originalInfo }) =>
      Effect.sync(() => {
        mutableOS.homedir = originalHome;
        mutableOS.userInfo = originalInfo;
        NodeModule.syncBuiltinESMExports();
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }),
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
const inspect = preflight;
const hash = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");

it.effect("accepts only pinned installed-history order and exact optional runtime objects", () =>
  fixture(
    (file) =>
      Effect.gen(function* () {
        const ready = yield* preflight(file);
        expect(ready.schema).toEqual({});
        expect(ready.verdict).toBe(fixtureVerdict);
        expect(ready.tables.styal_legacy_v1_rederived_items?.rows).toBe(1);
        expect(ready.tables.styal_legacy_v1_rederived_items?.rejected).toBe(0);
        edit(file, (db) => {
          db.exec(
            "DROP TRIGGER orchestration_v2_message_search_insert; DROP TRIGGER orchestration_v2_message_search_update; DROP TRIGGER orchestration_v2_message_search_delete",
          );
        });
        expect((yield* preflight(file)).verdict).toBe(fixtureVerdict);
        edit(file, (db) =>
          db.exec("ALTER TABLE styal_legacy_v1_rederived_items ADD COLUMN synthetic TEXT"),
        );
        expect((yield* preflight(file)).schema).toHaveProperty(
          "table / styal_legacy_v1_rederived_items / definition",
          1,
        );
        edit(file, (db) => {
          const row = db
            .prepare("SELECT sql FROM sqlite_schema WHERE name='projection_projects'")
            .get()!;
          const rows = db.prepare("SELECT * FROM projection_projects").all();
          const indexes = db
            .prepare(
              "SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='projection_projects' AND sql IS NOT NULL",
            )
            .all();
          db.exec("PRAGMA foreign_keys=OFF; DROP TABLE projection_projects");
          db.exec(
            String(row.sql).replace(
              "pinned_at TEXT, pin_order_key TEXT",
              "pin_order_key TEXT, pinned_at TEXT",
            ),
          );
          for (const data of rows) {
            const columns = Object.keys(data);
            db.prepare(
              `INSERT INTO projection_projects (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
            ).run(...Object.values(data));
          }
          for (const index of indexes) db.exec(String(index.sql));
        });
        expect((yield* preflight(file)).schema).toHaveProperty(
          "table / projection_projects / definition",
          1,
        );
      }),
    "installed-history",
  ),
);

it.effect(
  "attributes historical incompatibilities and nested unknowns without exposing row values or writing the source",
  () =>
    fixture((file) =>
      Effect.gen(function* () {
        edit(file, (db) =>
          db
            .prepare(
              "UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.modelSelection.options',json('[]'),'$.modelSelection.syntheticPrivateKey','RECOGNISABLE_PRIVATE_VALUE') WHERE thread_id='model-options-string'",
            )
            .run(),
        );
        const before = hash(file);
        const report = yield* inspect(file);
        expect(hash(file)).toBe(before);
        expect(report.verdict).toBe("unexpected");
        expect(report.tables.orchestration_events?.failures).not.toHaveProperty(
          "runtime-request.updated / payload.responseCapability",
        );
        expect(report.tables.orchestration_v2_projection_threads?.unknownFields).toHaveProperty(
          "threads / modelSelection.unrecognised-field",
          1,
        );
        expect(JSON.stringify(report)).not.toMatch(
          /RECOGNISABLE_PRIVATE_VALUE|syntheticPrivateKey|ada@example|Project Alpha|message-alpha/,
        );
        edit(file, (db) =>
          db.exec(
            "UPDATE orchestration_v2_projection_threads SET payload_json=json_remove(payload_json,'$.modelSelection.syntheticPrivateKey')",
          ),
        );
        const ready = yield* inspect(file);
        expect(ready.verdict).toBe(fixtureVerdict);
        expect(ready.tables.orchestration_events?.rows).toBe(22);
        for (const name of Object.keys(projectionCodecs))
          expect(ready.tables["orchestration_v2_projection_" + name]?.rows, name).toBeGreaterThan(
            0,
          );
        const coverage = new NodeSqlite.DatabaseSync(file, { readOnly: true });
        try {
          for (const key of Object.keys(columnCodecs)) {
            const [table, column] = key.split(".");
            if (Number(coverage.prepare(`SELECT count(*) n FROM "${table}"`).get()!.n) === 0)
              continue;
            expect(
              Number(
                coverage
                  .prepare(`SELECT count(*) n FROM "${table}" WHERE "${column}" IS NOT NULL`)
                  .get()!.n,
              ),
              key,
            ).toBeGreaterThan(0);
          }
        } finally {
          coverage.close();
        }
        expect(ready.tables.orchestration_events?.failures).not.toHaveProperty(
          "subagent.updated / payload.prompt",
        );
        expect(ready.tables.orchestration_v2_projection_provider_threads?.rejected).toBe(0);
        edit(file, (db) =>
          db.exec(
            `UPDATE projection_projects SET scripts_json='[{"id":"synthetic","name":"Synthetic","command":"synthetic","icon":"desktop","runOnWorktreeCreate":false}]'`,
          ),
        );
        expect((yield* inspect(file)).verdict).toBe(fixtureVerdict);
      }),
    ),
);

it.effect("ignores obsolete saved actions when checking a historical project", () =>
  fixture((file) =>
    Effect.gen(function* () {
      edit(file, (db) =>
        db.exec("UPDATE projection_projects SET scripts_json='obsolete not JSON'"),
      );
      const before = hash(file);
      expect((yield* inspect(file)).verdict).toBe(fixtureVerdict);
      expect(hash(file)).toBe(before);
    }),
  ),
);

it.effect("requires exact ledgers and schema definitions", () =>
  fixture((file) =>
    Effect.gen(function* () {
      for (const [sql, check] of [
        ["DELETE FROM effect_sql_migrations WHERE migration_id=1", "ledger"],
        ["DROP TABLE yngatech_sql_migrations", "schema"],
        [
          "INSERT INTO yngatech_sql_migrations(migration_id,name,created_at) VALUES(17,'synthetic-extra','2026-01-01')",
          "ledger",
        ],
        [
          "DROP INDEX idx_orch_events_command_id; CREATE INDEX synthetic_renamed_index ON orchestration_events(command_id)",
          "schema",
        ],
        [
          "UPDATE orchestration_events SET command_id='' WHERE event_type='runtime-request.updated'",
          "reader",
        ],
        [
          "UPDATE orchestration_events SET occurred_at='invalid-time' WHERE event_type='legacy-usage.imported'",
          "reader",
        ],
        ["UPDATE projection_projects SET default_thread_env_mode='invalid-mode'", "reader"],
        [
          "UPDATE orchestration_events SET sequence=-1,payload_json='{}' WHERE event_type='runtime-request.updated'",
          "reader",
        ],
        [
          "UPDATE orchestration_events SET sequence=0 WHERE event_type='runtime-request.updated'",
          "reader",
        ],
        [
          "UPDATE orchestration_events SET payload_json='{invalid' WHERE event_type='subagent.updated'",
          "reader",
        ],
      ] as const) {
        edit(file, (db) => {
          db.exec(sql);
        });
        const report = yield* inspect(file);
        expect(report.verdict, sql).toBe("unexpected");
        if (check === "schema") expect(Object.keys(report.schema).length).toBeGreaterThan(0);
        NodeFS.writeFileSync(
          file,
          NodeZlib.gunzipSync(
            NodeFS.readFileSync(NodePath.join(import.meta.dirname, "fixtures/preflight.sqlite.gz")),
          ),
        );
      }
    }),
  ),
);

it.effect(
  "reads committed nonempty WAL content and refuses live homes and their symlink aliases",
  () =>
    fixture((file, dir) =>
      Effect.gen(function* () {
        const writer = new NodeSqlite.DatabaseSync(file);
        try {
          writer.exec(
            "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.title',17) WHERE thread_id='ordinary'",
          );
          expect(NodeFS.statSync(file + "-wal").size).toBeGreaterThan(0);
          const report = yield* inspect(file);
          expect(report.tables.orchestration_v2_projection_threads?.failures).toHaveProperty(
            "threads / title / InvalidType",
            1,
          );
          const home = NodePath.join(dir, "home/.styal");
          NodeFS.mkdirSync(home, { recursive: true });
          NodeFS.symlinkSync(home, NodePath.join(dir, "alias"));
          NodeFS.symlinkSync(
            NodePath.join(home, "missing.sqlite"),
            NodePath.join(dir, "dangling.sqlite"),
          );
          expect(() => assertOffline(NodePath.join(dir, "dangling.sqlite"))).toThrow(
            "live-styal-home-refused",
          );
          expect(() => assertOffline(NodePath.join(home, "source.sqlite"))).toThrow(
            "live-styal-home-refused",
          );
          expect(() => assertOffline(NodePath.join(dir, "alias/source.sqlite"))).toThrow(
            "live-styal-home-refused",
          );
          NodeFS.linkSync(file, NodePath.join(dir, "hardlink.sqlite"));
          expect(() => assertOffline(file)).toThrow("regular-single-link-database-required");
          NodeFS.unlinkSync(NodePath.join(dir, "hardlink.sqlite"));
          const liveSidecar = NodePath.join(home, "synthetic-wal");
          NodeFS.writeFileSync(liveSidecar, "synthetic");
          NodeFS.symlinkSync(liveSidecar, NodePath.join(dir, "inert.sqlite-wal"));
          NodeFS.copyFileSync(file, NodePath.join(dir, "inert.sqlite"));
          const guarded = yield* preflight(NodePath.join(dir, "inert.sqlite")).pipe(Effect.exit);
          expect(guarded._tag).toBe("Failure");
          vi.stubEnv("STYAL_HOME", NodePath.join(dir, "custom"));
          expect(() => assertOffline(NodePath.join(dir, "custom/source.sqlite"))).toThrow(
            "live-styal-home-refused",
          );
        } finally {
          writer.close();
          vi.unstubAllEnvs();
        }
      }),
    ),
);

it.effect("keeps poison out of CLI stdout, stderr and report even for malformed events", () =>
  fixture((file, dir) =>
    Effect.gen(function* () {
      const poison = "RECOGNISABLE_SYNTHETIC_SECRET";
      edit(file, (db) =>
        db
          .prepare(
            "UPDATE orchestration_events SET payload_json=json_set(payload_json,'$.title',json_object('syntheticPrivateValue',?)) WHERE event_type='thread.created'",
          )
          .run(poison),
      );
      {
        edit(file, (db) =>
          db
            .prepare("UPDATE orchestration_v2_effect_outbox SET effect_type=?,payload_json='{}'")
            .run(poison),
        );
        const result = NodeChildProcess.spawnSync(
          process.execPath,
          [NodePath.join(import.meta.dirname, "preflightCli.ts"), file],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              HOME: NodePath.join(dir, "home"),
              T3CODE_TELEMETRY_ENABLED: "false",
              DO_NOT_TRACK: "1",
              T3CODE_ERROR_REPORTING_ENABLED: "false",
            },
          },
        );
        expect(result.status).toBe(1);
        const output = result.stdout + result.stderr;
        expect(JSON.parse(result.stdout)).toHaveProperty("tables");
        expect(output).not.toContain(poison);
        expect(output).toContain("Preflight: unexpected");
      }
    }),
  ),
);

it.effect("pins the schema actually emitted by the source migrations", () =>
  fixture((file) =>
    Effect.gen(function* () {
      const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
      try {
        expect(
          db
            .prepare("SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id")
            .all(),
        ).toEqual(source.ledger);
        for (const definition of source.definitions) {
          const row = db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(definition.name);
          if (!row && "optional" in definition && definition.optional) continue;
          expect(
            NodeCrypto.createHash("sha256").update(JSON.stringify(row!.sql)).digest("hex"),
          ).toBe(definition.hash);
        }
      } finally {
        db.close();
      }
    }),
  ),
);

const mainFacts = (file: string) => {
  const stat = NodeFS.statSync(file, { bigint: true });
  return { size: stat.size, modified: stat.mtimeNs, hash: hash(file) };
};
it.effect("reports SQLite sidecars while preserving writable and read-only main files", () =>
  fixture((file, dir) =>
    Effect.gen(function* () {
      edit(file, (db) => db.exec("PRAGMA journal_mode=WAL"));
      const before = mainFacts(file);
      const writable = yield* inspect(file);
      expect(mainFacts(file)).toEqual(before);
      expect(writable.sidecars.before).toEqual({
        wal: { exists: false, size: 0 },
        shm: { exists: false, size: 0 },
      });
      expect(writable.sidecars.after.wal.exists).toBe(true);
      expect(writable.sidecars.after.shm.size).toBeGreaterThan(0);
      expect(writable.sidecars.changed).toEqual(["wal", "shm"]);
      const snapshot = NodePath.join(dir, "readonly");
      NodeFS.mkdirSync(snapshot);
      const snapFile = NodePath.join(snapshot, "source.sqlite");
      // Copy only this synthetic database; the active writer keeps committed WAL content available.
      const writer = new NodeSqlite.DatabaseSync(file);
      try {
        writer.exec(
          "PRAGMA wal_autocheckpoint=0; UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.title',17) WHERE thread_id='ordinary'",
        );
        for (const suffix of ["", "-wal", "-shm"]) {
          NodeFS.copyFileSync(file + suffix, snapFile + suffix);
          NodeFS.chmodSync(snapFile + suffix, 0o444);
        }
      } finally {
        writer.close();
      }
      NodeFS.chmodSync(snapshot, 0o555);
      try {
        const snapBefore = mainFacts(snapFile);
        const readonly = yield* inspect(snapFile);
        expect(mainFacts(snapFile)).toEqual(snapBefore);
        expect(readonly.sidecars.after).toEqual(readonly.sidecars.before);
        expect(readonly.tables.orchestration_v2_projection_threads?.failures).toHaveProperty(
          "threads / title / InvalidType",
          1,
        );
        // The WAL-mode main file without its sidecars cannot be opened here.
        NodeFS.chmodSync(snapshot, 0o755);
        const missing = NodePath.join(snapshot, "missing.sqlite");
        NodeFS.copyFileSync(snapFile, missing);
        NodeFS.chmodSync(missing, 0o444);
        NodeFS.chmodSync(snapshot, 0o555);
        const failed = yield* inspect(missing).pipe(Effect.result);
        expect(Result.isFailure(failed)).toBe(true);
        if (Result.isFailure(failed))
          expect(failed.failure).toMatchObject({
            category: "read-only-source-unavailable-use-snapshot-with-sidecars-or-writable-copy",
          });
      } finally {
        NodeFS.chmodSync(snapshot, 0o755);
      }
    }),
  ),
);

it.effect("keeps a stable read-only WAL view ready and detects a real writer commit", () =>
  fixture((file, dir) =>
    Effect.gen(function* () {
      edit(file, (db) => db.exec("PRAGMA journal_mode=WAL"));
      yield* inspect(file);
      for (const suffix of ["", "-wal", "-shm"]) NodeFS.chmodSync(file + suffix, 0o444);
      NodeFS.chmodSync(dir, 0o555);
      try {
        const stable = yield* inspect(file);
        expect(stable.verdict).toBe(fixtureVerdict);
        expect(stable.globals["source-changed"]).toBeUndefined();
      } finally {
        NodeFS.chmodSync(dir, 0o755);
        for (const suffix of ["", "-wal", "-shm"]) NodeFS.chmodSync(file + suffix, 0o644);
      }
      let committed = false;
      const changed = yield* preflight(file, () => {
        if (!committed) {
          edit(file, (db) =>
            db.exec("UPDATE projection_projects SET title='Synthetic changed project'"),
          );
          committed = true;
        }
      });
      expect(changed.verdict).toBe("unexpected");
      expect(changed.globals["source-changed"]).toBe(1);
    }),
  ),
);

it.effect("counts updated FTS shadow contents without reading their large integer IDs", () =>
  fixture((file) =>
    Effect.gen(function* () {
      let shadowRows = 0,
        storedBytes = 0;
      edit(file, (db) => {
        db.exec("BEGIN");
        const insert = db.prepare(
          "INSERT INTO orchestration_v2_message_search(rowid,text) VALUES (?,?)",
        );
        for (let id = 1000; id < 5000; id++) insert.run(id, "Synthetic common search text");
        db.exec("COMMIT");
        db.prepare("UPDATE orchestration_v2_message_search SET text=? WHERE rowid=2000").run(
          "Synthetic changed search text",
        );
        expect(
          db
            .prepare(
              "SELECT count(*) n FROM orchestration_v2_message_search_data WHERE id>9007199254740991",
            )
            .get()!.n,
        ).toBeGreaterThan(0);
        const totals = db
          .prepare(
            "SELECT count(*) n, sum(length(CAST(id AS BLOB))+length(block)) bytes FROM orchestration_v2_message_search_data",
          )
          .get()!;
        shadowRows = Number(totals.n);
        storedBytes = Number(totals.bytes);
      });
      const report = yield* inspect(file);
      const shadow = report.tables.orchestration_v2_message_search_data!;
      expect(shadow.derived).toBe("shadow");
      expect(shadow.rows).toBe(shadowRows);
      expect(shadow.storedBytes).toBe(storedBytes);
      expect(shadow.rejected).toBe(0);
      expect(shadow.unknownFields).toEqual({});
      expect(report.tables.orchestration_v2_message_search?.derived).toBe("virtual");
      expect(report.tables.scheduled_tasks).toBeDefined();
    }),
  ),
);

it.effect("reports unsafe ordinary integers by table and column and continues the census", () =>
  fixture((file) =>
    Effect.gen(function* () {
      for (const value of [9007199254740992n, -9007199254740992n]) {
        edit(file, (db) => db.prepare("UPDATE projection_projects SET auto_pull=?").run(value));
        const report = yield* inspect(file);
        expect(report.verdict).toBe("unexpected");
        expect(report.globals["unsafe-integer / projection_projects / auto_pull"]).toBe(1);
        expect(report.tables.projection_projects?.scanSkipped).toBe("unsafe-integer");
        expect(report.tables.projection_projects?.rows).toBe(1);
        expect(report.tables.scheduled_tasks).toBeDefined();
      }
      edit(file, (db) =>
        db.prepare("UPDATE projection_projects SET auto_pull=0,rowid=?").run(9007199254740992n),
      );
      const cursor = yield* inspect(file);
      expect(cursor.globals["unsafe-integer / projection_projects / rowid"]).toBe(1);
      expect(cursor.tables.projection_projects?.scanSkipped).toBe("unsafe-integer");
      let eventRows = 0;
      edit(file, (db) => {
        db.prepare(
          "UPDATE orchestration_events SET sequence=? WHERE sequence=(SELECT min(sequence) FROM orchestration_events)",
        ).run(9007199254740992n);
        eventRows = Number(db.prepare("SELECT count(*) n FROM orchestration_events").get()!.n);
      });
      const events = yield* inspect(file);
      expect(events.globals["unsafe-integer / orchestration_events / sequence"]).toBe(1);
      expect(events.tables.orchestration_events?.scanSkipped).toBe("unsafe-integer");
      expect(events.tables.orchestration_events?.rows).toBe(eventRows);
    }),
  ),
);

it.effect("reports unsafe ledger IDs without materialising them as numbers", () =>
  fixture((file) =>
    Effect.gen(function* () {
      edit(file, (db) => {
        for (const table of ["effect_sql_migrations", "yngatech_sql_migrations"])
          db.prepare("UPDATE " + table + " SET migration_id=? WHERE migration_id=1").run(
            9007199254740992n,
          );
      });
      const report = yield* inspect(file);
      for (const table of ["effect_sql_migrations", "yngatech_sql_migrations"]) {
        expect(report.globals["unsafe-integer / " + table + " / migration_id"]).toBe(1);
        expect(report.ledgers[table]?.missing).toContain(1);
        expect(report.tables[table]?.scanSkipped).toBe("unsafe-integer");
      }
      expect(report.tables.scheduled_tasks).toBeDefined();
    }),
  ),
);

it.effect("counts each unsupported event row once across overlapping header problems", () =>
  fixture((file) =>
    Effect.gen(function* () {
      const before = yield* inspect(file);
      edit(file, (db) => {
        const insert = db.prepare(
          "INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version) VALUES(?,?,?,?,1,'thread.created','2026-01-01T00:00:00.000Z','server','{}','{}',?)",
        );
        for (const [sequence, aggregate, version] of [
          [1001, "thread", 1],
          [-1, "thread", 1],
          [1002, "thread", 9],
          [-2, "thread", 9],
          [1003, "synthetic-unknown", 2],
          [-3, "synthetic-unknown", 9],
          [-4, "thread", 2],
        ] as const)
          insert.run(
            sequence,
            "synthetic-header-" + sequence,
            aggregate,
            "synthetic-stream-" + sequence,
            version,
          );
      });
      const report = yield* inspect(file);
      const initial = before.tables.orchestration_events!;
      const events = report.tables.orchestration_events!;
      expect(events.rows).toBe(initial.rows + 7);
      expect(events.rejected).toBe(initial.rejected + 7);
      for (const [reason, count] of [
        ["legacy-v1-event / unsupported-reader", 2],
        ["unsupported-version-event / unsupported-reader", 2],
        ["unrecognised-aggregate-event / unsupported-reader", 2],
        ["events / sequence", 1],
      ] as const)
        expect(events.failures[reason]).toBe((initial.failures[reason] ?? 0) + count);
    }),
  ),
);

it.effect(
  "sizes distinct unknown-bearing rows and columns without counting a row once per path",
  () =>
    fixture((file) =>
      Effect.gen(function* () {
        const initial = yield* inspect(file);
        let bytes = 0;
        edit(file, (db) => {
          db.exec(
            "UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.syntheticFieldA',1,'$.syntheticFieldB',2) WHERE thread_id='ordinary'",
          );
          bytes = Buffer.byteLength(
            String(
              db
                .prepare(
                  "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='ordinary'",
                )
                .get()!.payload_json,
            ),
          );
          db.exec(
            "UPDATE projection_projects SET default_model_selection_json=json_set(default_model_selection_json,'$.syntheticFieldA',1,'$.syntheticFieldB',2)",
          );
        });
        const issue = {
          version: 1,
          contextId: "synthetic-issue",
          label: "Synthetic issue",
          kind: "issue",
          provider: "github",
          repository: "synthetic/project",
          number: 1,
          title: "Synthetic issue",
          url: "https://example.test/synthetic/1",
          state: "open",
          author: null,
          body: "Synthetic body",
          comments: [],
        };
        edit(file, (db) =>
          db
            .prepare("UPDATE projection_thread_messages SET context_json=?")
            .run(JSON.stringify({ version: 1, records: [issue] })),
        );
        const report = yield* inspect(file);
        const before = initial.tables.orchestration_v2_projection_threads!;
        const after = report.tables.orchestration_v2_projection_threads!;
        expect(after.archiveCandidateRows).toBe(before.archiveCandidateRows + 1);
        expect(after.archiveCandidateBytes).toBe(before.archiveCandidateBytes + bytes);
        const projects = report.tables.projection_projects!;
        expect(projects.jsonColumns.default_model_selection_json?.unknownRows).toBe(1);
        expect(projects.jsonColumns.default_model_selection_json?.unknownBytes).toBeGreaterThan(0);
        expect(projects.archiveCandidateRows).toBe(1);
        expect(projects.jsonColumns.scripts_json?.unknownRows).toBe(1);
        const contexts = report.tables.projection_thread_messages!;
        expect(contexts.jsonColumns.context_json?.unknownRows).toBe(1);
        expect(contexts.unknownFields).toHaveProperty("context_json / records.[].provider", 1);
        const attachment = {
          version: 1,
          contextId: "synthetic-file",
          label: "Synthetic file",
          kind: "file",
          attachmentId: "synthetic-attachment",
          name: "synthetic.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
        };
        for (const records of [
          [issue, attachment],
          [attachment, issue],
        ]) {
          edit(file, (db) =>
            db
              .prepare("UPDATE projection_thread_messages SET context_json=?")
              .run(JSON.stringify({ version: 1, records })),
          );
          const mixed = (yield* inspect(file)).tables.projection_thread_messages!;
          expect(mixed.unexpected).toBe(contexts.unexpected);
          expect(mixed.unknownFields).toEqual(contexts.unknownFields);
          expect(mixed.jsonColumns.context_json?.unknownRows).toBe(1);
        }
        let rejectedBytes = 0;
        edit(file, (db) => {
          db.exec(
            "UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.title',42,'$.branchTurnContext',json('{\"id\":\"synthetic-context\",\"text\":\"Synthetic context\"}')) WHERE thread_id='ordinary'",
          );
          rejectedBytes = Buffer.byteLength(
            String(
              db
                .prepare(
                  "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='ordinary'",
                )
                .get()!.payload_json,
            ),
          );
        });
        const rejected = (yield* inspect(file)).tables.orchestration_v2_projection_threads!;
        expect(rejected.rejected).toBe(after.rejected + 1);
        expect(rejected.unknownFields).toHaveProperty("threads / branchTurnContext.text", 1);
        expect(rejected.archiveCandidateRows).toBe(after.archiveCandidateRows);
        expect(rejected.archiveCandidateBytes).toBe(
          after.archiveCandidateBytes - bytes + rejectedBytes,
        );
      }),
    ),
);

it.effect(
  "censuses every source projection and event witness without diagnostic false positives",
  () =>
    fixture((file) =>
      Effect.gen(function* () {
        const shapes = decodeCensus(
          NodeZlib.gunzipSync(
            NodeFS.readFileSync(new URL("./fixtures/compatibility.json.gz", import.meta.url)),
          ).toString(),
        ).shapes;
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
        edit(file, (db) => {
          db.exec("BEGIN");
          let ordinal = 1000;
          for (const shape of shapes) {
            if (
              !shape.name.startsWith("projection.") &&
              shape.name !== "thread-event" &&
              shape.name !== "project-event"
            )
              continue;
            const n = ++ordinal;
            const value = censusRecord(shape.value);
            if (shape.name.startsWith("projection.")) {
              const kind = kinds[names.indexOf(shape.name.slice(11))];
              if (kind === undefined) throw new Error("Unmapped projection witness");
              const table = "orchestration_v2_projection_" + kind;
              const p: Record<string, unknown> = { ...value, id: "synthetic-census-" + n };
              const row: Record<string, string | number | null> = {};
              for (const column of db.prepare("PRAGMA table_info(" + table + ")").all()) {
                const name = String(column.name);
                const camel = name.replace(/_([a-z])/g, (_, letter: string) =>
                  letter.toUpperCase(),
                );
                let v: unknown = column.pk
                  ? p.id
                  : name === "payload_json"
                    ? JSON.stringify(p)
                    : name.endsWith("_id")
                      ? "synthetic-census-ref-" + n
                      : name === "provider"
                        ? "codex"
                        : p[camel];
                if (typeof v === "boolean") v = Number(v);
                if (v === undefined) {
                  if (!column.notnull) v = null;
                  else if (column.dflt_value !== null) continue;
                  else v = column.type === "INTEGER" ? 1 : "synthetic";
                }
                row[name] = censusScalar(v);
              }
              db.prepare(
                "INSERT INTO " +
                  table +
                  " (" +
                  Object.keys(row).join(",") +
                  ") VALUES (" +
                  Object.keys(row)
                    .map(() => "?")
                    .join(",") +
                  ")",
              ).run(...Object.values(row));
            } else {
              const project = shape.name === "project-event";
              const metadata = project
                ? value.metadata
                : Object.fromEntries(
                    ["runId", "nodeId", "driver", "providerInstanceId", "rawEventId"]
                      .filter((key) => value[key] !== undefined)
                      .map((key) => [key, value[key]]),
                  );
              db.prepare(
                "INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version) VALUES(?,?,?,?,?,?,'server',?,?,2)",
              ).run(
                "synthetic-census-event-" + n,
                project ? "project" : "thread",
                "synthetic-census-stream-" + n,
                1,
                censusScalar(value.type),
                censusScalar(value.occurredAt),
                JSON.stringify(value.payload),
                JSON.stringify(metadata),
              );
            }
          }
          db.exec("COMMIT");
        });
        const report = yield* inspect(file);
        // Independent witnesses do not form one linked thread graph; check their row diagnostics.
        for (const table of [
          "orchestration_events",
          ...kinds.map((kind) => "orchestration_v2_projection_" + kind),
        ]) {
          expect(report.tables[table]?.rejected, table).toBe(0);
          expect(report.tables[table]?.unexpected, table).toBe(0);
        }
        expect(report.tables.orchestration_events?.unknownFields).not.toHaveProperty(
          "thread.created / runId",
        );
        expect(
          report.tables.orchestration_v2_projection_messages?.unknownFields,
        ).not.toHaveProperty("messages / notification.source.pullRequest.host");
        expect(
          report.tables.orchestration_v2_projection_provider_threads?.unknownFields,
        ).toHaveProperty("provider_threads / pendingBackgroundTasks.[].command.nativeItemId");
        edit(file, (db) =>
          db.exec(
            "UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,'$.text',42) WHERE message_id=(SELECT message_id FROM orchestration_v2_projection_messages WHERE json_type(payload_json,'$.notification.source.pullRequest')='object' LIMIT 1)",
          ),
        );
        const rejected = (yield* inspect(file)).tables.orchestration_v2_projection_messages!;
        expect(rejected.rejected).toBe(1);
        expect(rejected.unknownFields).not.toHaveProperty(
          "messages / notification.source.pullRequest.host",
        );
        expect(rejected.unknownFields).toHaveProperty(
          "messages / notification.source.pullRequest.supersedesUpdates",
        );
      }),
    ),
);
