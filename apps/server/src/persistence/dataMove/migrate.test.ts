// @effect-diagnostics processEnvInEffect:off - Synthetic guard environment is restored in finally.
// @effect-diagnostics nodeBuiltinImport:off - Synthetic offline migration proof.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import { archive } from "./archive.ts";
import { neutralise } from "./neutralise.ts";
import { migrate } from "./migrate.ts";
import { runAllMigrations } from "../ForkMigrations.ts";

const root = NodeOS.tmpdir();
function fixture<A, E, R>(run: (file: string) => Effect.Effect<A, E, R>, family = "preflight") {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const dir = NodeFS.mkdtempSync(NodePath.join(root, "bridge-fixture-"));
      const file = NodePath.join(dir, "source.sqlite");
      NodeFS.writeFileSync(
        file,
        NodeZlib.gunzipSync(
          NodeFS.readFileSync(new URL(`./fixtures/${family}.sqlite.gz`, import.meta.url)),
        ),
      );
      return { file, dir };
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
const startup = (file: string) =>
  runAllMigrations().pipe(
    Effect.provide(
      NodeSqliteClient.layer({ filename: file, readerWorker: false, writerWorker: false }),
    ),
  );
const refused = (file: string, category: string, verify = false) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(migrate(file, verify));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.category).toBe(category);
  });

it.effect.each([
  ["cutover", "preflight"],
  ["rehearsal", "preflight"],
  ["cutover", "installed-history"],
  ["rehearsal", "installed-history"],
] as const)(
  "moves and verifies a %s %s source through the guarded startup path",
  ([mode, family]) =>
    fixture(
      (file) =>
        Effect.gen(function* () {
          expect((yield* Effect.result(startup(file)))._tag).toBe("Failure");
          yield* archive(file);
          yield* neutralise(file, mode);
          if (mode === "cutover") {
            const cli = NodeChildProcess.spawnSync(
              process.execPath,
              [NodePath.join(import.meta.dirname, "migrateCli.ts"), file],
              {
                encoding: "utf8",
                env: {
                  ...process.env,
                  T3CODE_PORT: undefined,
                  HOME: NodePath.join(NodePath.dirname(file), "home"),
                  T3CODE_TELEMETRY_ENABLED: "false",
                  DO_NOT_TRACK: "1",
                  T3CODE_ERROR_REPORTING_ENABLED: "false",
                  T3CODE_DEV_SEED: "0",
                },
              },
            );
            expect(cli.status, cli.stderr).toBe(0);
            expect(JSON.parse(cli.stdout).completed).toBe(true);
          }
          const report = yield* migrate(file);
          expect(report.archiveIntact).toBe(true);
          expect(report.mode).toBe(mode);
          if (family === "installed-history") {
            expect(report.leftovers.styal_legacy_v1_rederived_items?.rows).toBe(1);
            expect(report.notDecoded.styal_legacy_v1_rederived_items?.rows).toBe(1);
            expect(report.leftovers.sqlite_stat1?.rows).toBe(0);
          }
          expect(report.leftovers.hardware_leases?.rows).toBeGreaterThanOrEqual(0);
          yield* startup(file);
          expect((yield* migrate(file)).completed).toBe(true);
          const before = NodeFS.readFileSync(file);
          expect((yield* migrate(file, true)).completed).toBe(true);
          expect(NodeFS.readFileSync(file)).toEqual(before);
          if (mode === "cutover") {
            const env = {
              ...process.env,
              T3CODE_PORT: undefined,
              HOME: NodePath.join(NodePath.dirname(file), "home"),
              T3CODE_TELEMETRY_ENABLED: "false",
              DO_NOT_TRACK: "1",
              T3CODE_ERROR_REPORTING_ENABLED: "false",
              T3CODE_DEV_SEED: "0",
            };
            const cli = NodeChildProcess.spawnSync(
              process.execPath,
              [NodePath.join(import.meta.dirname, "migrateCli.ts"), file, "--verify"],
              { encoding: "utf8", env },
            );
            expect(cli.status, cli.stderr).toBe(0);
            expect(JSON.parse(cli.stdout).archiveIntact).toBe(true);
            expect(cli.stdout).not.toContain(file);
            expect(cli.stdout).not.toContain("synthetic-");
            const invalid = NodeChildProcess.spawnSync(
              process.execPath,
              [
                NodePath.join(import.meta.dirname, "migrateCli.ts"),
                file,
                "--SYNTHETIC_PRIVATE_ARGUMENT",
              ],
              { encoding: "utf8", env },
            );
            expect(invalid.status).toBe(1);
            expect(JSON.parse(invalid.stderr)).toEqual({ refused: "migration-failed" });
            expect(invalid.stdout + invalid.stderr).not.toContain(file);
            expect(invalid.stdout + invalid.stderr).not.toContain("SYNTHETIC_PRIVATE_ARGUMENT");
            expect(NodeFS.readFileSync(file)).toEqual(before);
          }
        }),
      family,
    ),
);

it.effect("refuses each bridge precondition and a damaged completion marker", () =>
  fixture((file) =>
    Effect.gen(function* () {
      yield* refused(file, "completion-marker-required", true);
      yield* refused(file, "archive-required-and-intact");
      yield* archive(file);
      yield* refused(file, "neutralisation-marker-required");
      yield* neutralise(file, "rehearsal");
      const pristine = NodeFS.readFileSync(file);
      const reset = () => NodeFS.writeFileSync(file, pristine);
      for (const [sql, category] of [
        [
          "DELETE FROM effect_sql_migrations WHERE migration_id=86",
          "source-ledgers-required-discard-partial-copy",
        ],
        [
          "UPDATE yngatech_sql_migrations SET name='synthetic' WHERE migration_id=16",
          "source-ledgers-required-discard-partial-copy",
        ],
        ["DROP TABLE styal_archive_raw_manifest", "archive-required-and-intact"],
        ["UPDATE styal_archive_raw_cells SET sha256='synthetic'", "archive-required-and-intact"],
        ["UPDATE styal_neutralisation SET impact_json='{}'", "neutralisation-marker-invalid"],
        ["UPDATE styal_neutralisation SET completed_at='invalid'", "neutralisation-marker-invalid"],
        [
          "ALTER TABLE styal_neutralisation ADD COLUMN synthetic TEXT",
          "neutralisation-marker-invalid",
        ],
        ["UPDATE scheduled_tasks SET enabled=1", "executable-state-remains"],
      ]) {
        edit(file, (db) => db.exec(sql!));
        yield* refused(file, category!);
        reset();
      }
      yield* migrate(file);
      edit(file, (db) => db.exec("UPDATE styal_data_move SET tool_commit='synthetic'"));
      yield* refused(file, "completion-marker-invalid", true);
      expect((yield* Effect.result(startup(file)))._tag).toBe("Failure");
    }),
  ),
);

it.effect("refuses unlisted leftovers, broken runtime rows and foreign keys on verification", () =>
  fixture((file) =>
    Effect.gen(function* () {
      yield* archive(file);
      yield* neutralise(file, "rehearsal");
      yield* migrate(file);
      const pristine = NodeFS.readFileSync(file);
      for (const [sql, category] of [
        ["CREATE TABLE synthetic_leftover(value TEXT)", "unlisted-or-changed-target-schema"],
        [
          "ALTER TABLE hardware_leases ADD COLUMN synthetic TEXT",
          "unlisted-or-changed-target-schema",
        ],
        ["CREATE VIEW synthetic_view AS SELECT 1", "unlisted-or-changed-target-schema"],
        [
          "DROP TRIGGER orchestration_v2_thread_item_counts_count_insert",
          "unlisted-or-changed-target-schema",
        ],
        ["ALTER TABLE workflow_mail DROP COLUMN sender_json", "unlisted-or-changed-target-schema"],
        ["DELETE FROM styal_data_move", "completion-marker-invalid"],
        ["DROP TABLE styal_data_move", "completion-marker-required"],
        [
          "INSERT INTO orchestration_v2_projection_metadata(projection_name,schema_version,last_sequence,updated_at) SELECT 'event-log-pruned-through',1,last_sequence+1,'2026-01-01T00:00:00.000Z' FROM orchestration_v2_projection_metadata WHERE projection_name='thread-projections' ON CONFLICT(projection_name) DO UPDATE SET last_sequence=excluded.last_sequence",
          "projection-consistency-required / invalid-metadata-cursor",
        ],
        [
          "DELETE FROM orchestration_v2_projection_metadata WHERE projection_name='thread-projections'",
          "projection-consistency-required / projection-cursor-missing",
        ],
        [
          "UPDATE orchestration_v2_projection_metadata SET schema_version=999 WHERE projection_name='thread-projections'",
          "projection-consistency-required / projection-version-not-2",
        ],
        [
          "UPDATE orchestration_v2_projection_metadata SET last_sequence=0 WHERE projection_name='thread-projections'",
          "projection-consistency-required / unprojected-event-tail",
        ],
        [
          "UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,'$.text',17)",
          "restart-reader-rejected",
        ],
        [
          "PRAGMA foreign_keys=OFF; CREATE TABLE synthetic_bad_fk(value TEXT REFERENCES projection_projects(project_id)); INSERT INTO synthetic_bad_fk VALUES ('synthetic-missing')",
          "foreign-key-check-failed",
        ],
      ]) {
        edit(file, (db) => db.exec(sql!));
        yield* refused(file, category!, true);
        if (sql === "DROP TABLE styal_data_move")
          expect((yield* Effect.result(startup(file)))._tag).toBe("Failure");
        NodeFS.writeFileSync(file, pristine);
      }
    }),
  ),
);

it.effect("leaves committed earlier migrations after a late failure and refuses to resume", () =>
  fixture((file) =>
    Effect.gen(function* () {
      yield* archive(file);
      yield* neutralise(file, "rehearsal");
      const prepare = NodeSqlite.DatabaseSync.prototype.prepare;
      using spy = vi
        .spyOn(NodeSqlite.DatabaseSync.prototype, "prepare")
        .mockImplementation(function (this: NodeSqlite.DatabaseSync, sql: string) {
          if (sql.includes("ALTER TABLE workflow_mail ADD COLUMN sender_json"))
            throw new Error("synthetic late failure");
          return prepare.call(this, sql);
        });
      yield* refused(file, "migration-failed-discard-copy");
      spy.mockRestore();
      edit(file, (db) => {
        expect(db.prepare("SELECT max(migration_id) n FROM effect_sql_migrations").get()!.n).toBe(
          116,
        );
        expect(
          db
            .prepare("PRAGMA table_info(workflow_mail)")
            .all()
            .some((c) => c.name === "sender_json"),
        ).toBe(false);
      });
      yield* refused(file, "source-ledgers-required-discard-partial-copy");
      expect((yield* Effect.result(startup(file)))._tag).toBe("Failure");
    }),
  ),
);

it.effect(
  "refuses source schema changes before advancing ledgers and refuses startup after final validation fails",
  () =>
    fixture((file) =>
      Effect.gen(function* () {
        yield* archive(file);
        yield* neutralise(file, "cutover");
        const pristine = NodeFS.readFileSync(file);
        for (const ddl of [
          "CREATE VIEW synthetic_view AS SELECT 1",
          "CREATE TRIGGER synthetic_trigger AFTER UPDATE ON projection_projects BEGIN SELECT 1; END",
        ]) {
          edit(file, (db) => db.exec(ddl));
          yield* refused(file, "source-schema-required");
          edit(file, (db) =>
            expect(
              db.prepare("SELECT max(migration_id) n FROM effect_sql_migrations").get()!.n,
            ).toBe(86),
          );
          NodeFS.writeFileSync(file, pristine);
        }
        for (const [mutation, category] of [
          [
            "UPDATE peer_environment_links SET access='synthetic-invalid'",
            "restart-peer-reader-rejected",
          ],
          [
            "UPDATE peer_environment_links SET linked_at='synthetic-invalid'",
            "restart-peer-reader-rejected",
          ],
          [
            "DELETE FROM orchestration_v2_projection_metadata WHERE projection_name='thread-projections'",
            "projection-consistency-required / projection-cursor-missing",
          ],
        ]) {
          edit(file, (db) => db.exec(mutation!));
          yield* refused(file, category!);
          edit(file, (db) => {
            expect(
              db.prepare("SELECT max(migration_id) n FROM effect_sql_migrations").get()!.n,
            ).toBe(117);
            expect(
              db.prepare("SELECT max(migration_id) n FROM yngatech_sql_migrations").get()!.n,
            ).toBe(17);
          });
          expect((yield* Effect.result(startup(file)))._tag).toBe("Failure");
          yield* refused(file, "source-ledgers-required-discard-partial-copy");
          NodeFS.writeFileSync(file, pristine);
        }
      }),
    ),
);

it.effect("starts fresh and restart-native databases normally", () =>
  fixture((file) =>
    Effect.gen(function* () {
      NodeFS.unlinkSync(file);
      yield* startup(file);
      yield* startup(file);
    }),
  ),
);

it.effect("refuses live-home and sidecar paths before opening them", () =>
  fixture((file) =>
    Effect.gen(function* () {
      const previous = process.env.STYAL_HOME;
      try {
        process.env.STYAL_HOME = NodePath.dirname(file);
        yield* refused(file, "live-styal-home-refused");
      } finally {
        if (previous === undefined) delete process.env.STYAL_HOME;
        else process.env.STYAL_HOME = previous;
      }
    }),
  ),
);
