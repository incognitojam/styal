// @effect-diagnostics nodeBuiltinImport:off - Offline SQLite tooling needs synchronous Node file and descriptor operations.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeNet from "node:net";
import * as NodeChildProcess from "node:child_process";
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import * as NodeModule from "node:module";
import * as NodeSqlite from "node:sqlite";
import { describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Contracts from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import { inventory, sourcePath } from "./inventory.ts";
import { createTarget } from "./target.ts";

const scratch = NodePath.resolve(import.meta.dirname, "../../../../../.scratch");
const cli = NodePath.join(import.meta.dirname, "cli.ts");
const hash = (path: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
function makeFixture() {
  NodeFS.mkdirSync(scratch, { recursive: true });
  const dir = NodeFS.mkdtempSync(NodePath.join(scratch, "data-inventory-test-"));
  const file = NodePath.join(dir, "source.sqlite");
  NodeFS.writeFileSync(
    file,
    NodeZlib.gunzipSync(
      NodeFS.readFileSync(NodePath.join(import.meta.dirname, "fixtures/source.sqlite.gz")),
    ),
  );
  return { file, dir };
}
async function fixture(run: (file: string, dir: string) => Promise<void>) {
  const { file, dir } = makeFixture();
  try {
    await run(file, dir);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}
const inspect = (source: string) => inventory({ source });
function edit(file: string, run: (db: NodeSqlite.DatabaseSync) => void) {
  const db = new NodeSqlite.DatabaseSync(file);
  try {
    run(db);
  } finally {
    db.close();
  }
}

describe("offline data inventory", () => {
  it("classifies migrated synthetic history and inert-state work without changing the source", () =>
    fixture(async (file, dir) => {
      const before = hash(file);
      const files = NodeFS.readdirSync(dir);
      const report = await inspect(file);
      expect(hash(file)).toBe(before);
      expect(NodeFS.readdirSync(dir)).toEqual(files);
      expect(report.verdict).toBe("blocked-unclassified");
      expect(report.tables.filter((table) => table.schema === "source-only")).toHaveLength(
        Object.hasOwn(Contracts.ApplicationProjectCreatedPayload.fields, "additionalInstructions")
          ? 7
          : 8,
      );
      expect(
        report.tables.filter((table) => table.schema === "target-only").length,
      ).toBeGreaterThanOrEqual(17);
      const carriesMaterializedForks = Object.hasOwn(
        Contracts.OrchestrationV2AppThread.fields,
        "forkHistoryMaterialized",
      );
      expect(report.payloads["orchestration_v2_projection_threads.payload_json"]).toMatchObject({
        clean: carriesMaterializedForks ? 7 : 5,
        drops: carriesMaterializedForks ? 1 : 3,
        fails: { "target-schema-rejected": 1 },
        fields: {
          ...(carriesMaterializedForks ? {} : { forkHistoryMaterialized: 2 }),
          reportTo: 1,
          workflowRuns: 1,
          authRecovery: 1,
          settleReason: 1,
        },
      });
      expect(report.payloads["orchestration_v2_projection_messages.payload_json"]).toMatchObject({
        drops: 1,
        fields: { report: 1, reportAnswer: 1, legacyTurnId: 1 },
      });
      expect(
        report.payloads["orchestration_v2_projection_provider_turns.payload_json"],
      ).toMatchObject({ drops: 1, fields: { nativePromptRef: 1 } });
      expect(report.payloads["orchestration_v2_projection_turn_items.payload_json"]).toMatchObject({
        drops: 1,
        fields: { legacyActivities: 1, legacyTurnId: 1, report: 1 },
      });
      expect(report.payloads["orchestration_v2_projection_checkpoints.payload_json"]).toMatchObject(
        {
          drops: 1,
          fields: { legacyTurnId: 1, assistantMessageId: 1, legacyCheckpointTurnCount: 1 },
        },
      );
      for (const kind of [
        "legacy-usage.imported",
        "message.mentioned-times-checked",
        "runtime-request.updated",
      ])
        expect(report.events[`orchestration_events.${kind}`]?.fails).toEqual({
          "target-schema-rejected": 1,
        });
      expect(report.pruning).toMatchObject({
        legacyThreads: 2,
        importMarkers: 1,
        streams: [
          { kind: "thread-v2", total: 9, snapshotsOnly: 2 },
          { kind: "thread-v1", total: 2, snapshotsOnly: 2 },
          { kind: "project", total: 1, snapshotsOnly: 1 },
        ],
      });
      for (const table of [
        "auth_sessions",
        "peer_environment_links",
        "scheduled_tasks",
        "orchestration_v2_effect_outbox",
      ])
        expect(report.tables.find((entry) => entry.table === table)?.action).toBe("neutralise");
      expect(report.versions).toEqual({ recognised: 1, unrecognised: 0 });
    }));

  it("refuses the live path, a nonempty WAL, and unknown or incomplete ledgers", () =>
    fixture(async (file) => {
      expect(() =>
        sourcePath(NodePath.join(NodeOS.homedir(), ".styal/userdata/synthetic.sqlite")),
      ).toThrow("live-source-refused");
      const writer = new NodeSqlite.DatabaseSync(file);
      try {
        writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE synthetic_pending (value TEXT)");
        expect(NodeFS.statSync(file + "-wal").size).toBeGreaterThan(0);
        const before = hash(file);
        await expect(inspect(file)).rejects.toThrow("checkpointed-offline-copy-required");
        expect(hash(file)).toBe(before);
      } finally {
        writer.close();
      }
      edit(file, (db) =>
        db.exec(
          "UPDATE yngatech_sql_migrations SET name = 'SyntheticUnknownMigration' WHERE migration_id = 16",
        ),
      );
      const before = hash(file);
      await expect(inspect(file)).rejects.toThrow("unrecognised-migration-ledger");
      expect(hash(file)).toBe(before);
      edit(file, (db) => db.exec("DROP TABLE yngatech_sql_migrations"));
      await expect(inspect(file)).rejects.toThrow("unrecognised-migration-ledger");
    }));

  it("keeps arbitrary content, identifiers, dictionary keys, SQL and decoder diagnostics out of reports", () =>
    fixture(async (file, dir) => {
      const privateValue = "SYNTHETIC-PRIVATE-12345";
      edit(file, (db) => {
        const row = db
          .prepare(
            "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = 'ordinary'",
          )
          .get()!;
        const payload = JSON.parse(String(row.payload_json));
        payload.title = privateValue;
        payload[privateValue] = privateValue;
        db.prepare(
          "UPDATE orchestration_v2_projection_threads SET payload_json = ? WHERE thread_id = 'ordinary'",
        ).run(JSON.stringify(payload));
        db.prepare(
          "UPDATE orchestration_events SET event_type = ?, event_id = ? WHERE event_type = 'legacy-usage.imported'",
        ).run(privateValue, privateValue);
        db.exec(
          `CREATE TABLE "${privateValue}" ("${privateValue}" TEXT DEFAULT '${privateValue}')`,
        );
      });
      const settings = NodePath.join(dir, "settings.json");
      NodeFS.writeFileSync(
        settings,
        JSON.stringify({
          providerInstances: { [privateValue]: privateValue },
          coordinatorReportsEnabled: privateValue,
          [privateValue]: privateValue,
        }),
      );
      const report = await inventory({ source: file, settings });
      const text = JSON.stringify(report);
      for (const value of [
        privateValue,
        "Project Alpha",
        "ada@example.test",
        "Synthetic message",
        "synthetic-secret",
        "peer.example.test",
        "/synthetic/project-alpha",
        "message-alpha",
        "missing-parent",
      ])
        expect(text.includes(value)).toBe(false);
      expect(report.settings).toMatchObject({
        accepted: ["providerInstances"],
        unknown: ["coordinatorReportsEnabled"],
        unrecognised: 1,
      });
      expect(report.settings.compatibility.providerInstances?.fails).toEqual({
        "target-schema-rejected": 1,
      });
      expect(
        report.payloads["orchestration_v2_projection_threads.payload_json"]?.fields[
          "unrecognised-field"
        ],
      ).toBe(1);
      expect(report.events["orchestration_events.unrecognised-event"]?.fails).toEqual({
        "unclassified-event": 1,
      });
      expect(report.verdict).toBe("blocked-unclassified");
      expect(report.blockers["unrecognised-json-field"]).toBe(1);
    }));

  it("runs the CLI with exclusive report output and refuses reports beside the source", () =>
    fixture(async (file, dir) => {
      const output = dir + "-report.json";
      const before = hash(file);
      const result = NodeChildProcess.spawnSync(process.execPath, [cli, file, "--report", output], {
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.summary).toContain("No server was run");
      expect(NodeFS.readFileSync(output, "utf8")).toBe(result.stdout);
      NodeFS.rmSync(output);
      const refused = NodeChildProcess.spawnSync(
        process.execPath,
        [cli, file, "--report", NodePath.join(dir, "report.json")],
        { encoding: "utf8" },
      );
      expect(refused.status).toBe(1);
      expect(refused.stdout).toBe("");
      expect(JSON.parse(refused.stderr)).toEqual({ refused: "unsafe-report-destination" });
      expect(NodeFS.existsSync(NodePath.join(dir, "report.json"))).toBe(false);
      expect(hash(file)).toBe(before);
    }));

  it("visits malformed late rows and blocks unknown projection versions without diagnostics", () =>
    fixture(async (file) => {
      edit(file, (db) =>
        db.exec(
          "UPDATE orchestration_v2_projection_threads SET payload_json = 'synthetic invalid JSON' WHERE thread_id = 'model-options-string'; UPDATE orchestration_v2_projection_metadata SET schema_version = 999, last_sequence = 1000000; UPDATE orchestration_events SET application_event_version = 99 WHERE event_type = 'legacy-usage.imported'; UPDATE orchestration_events SET metadata_json = '{\"payload\":{\"syntheticLostMeaning\":true},\"id\":\"synthetic-lost-id\"}' WHERE event_type = 'thread.created'",
        ),
      );
      const report = await inspect(file);
      expect(report.payloads["orchestration_v2_projection_threads.payload_json"]).toMatchObject({
        rows: 9,
        fails: { "invalid-json": 1 },
      });
      expect(report.blockers["unrecognised-projection-version"]).toBe(1);
      expect(report.blockers["cursor-beyond-sequence-allocation"]).toBe(1);
      expect(report.blockers["unrecognised-application-version"]).toBe(1);
      expect(
        report.events["orchestration_events.thread.created"]?.fails["metadata-header-collision"],
      ).toBe(7);
      expect(
        report.tables.find((entry) => entry.table === "orchestration_v2_projection_metadata")
          ?.action,
      ).toBe("transform");
      expect(JSON.stringify(report)).not.toContain("synthetic invalid JSON");
    }));

  it("detects a source change during target initialization", () =>
    fixture(async (file) => {
      const pending = inspect(file);
      NodeFS.appendFileSync(file, new Uint8Array(4096));
      NodeFS.writeFileSync(file + "-wal", "synthetic WAL");
      await expect(pending).rejects.toThrow("source-changed");
    }));

  it.effect("builds only migration data services and cannot overwrite a database", () =>
    Effect.gen(function* () {
      const { file, dir } = yield* Effect.acquireRelease(Effect.sync(makeFixture), ({ dir }) =>
        Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
      );
      const require = NodeModule.createRequire(import.meta.url);
      const mutableChildProcess = require("node:child_process") as typeof NodeChildProcess;
      const mutableWorkers = require("node:worker_threads") as typeof NodeWorkerThreads;
      using spies = new DisposableStack();
      const listen = spies.use(vi.spyOn(NodeNet.Server.prototype, "listen"));
      const spawn = spies.use(vi.spyOn(mutableChildProcess, "spawn"));
      const spawnSync = spies.use(vi.spyOn(mutableChildProcess, "spawnSync"));
      const exec = spies.use(vi.spyOn(mutableChildProcess, "exec"));
      const execFile = spies.use(vi.spyOn(mutableChildProcess, "execFile"));
      const execSync = spies.use(vi.spyOn(mutableChildProcess, "execSync"));
      const execFileSync = spies.use(vi.spyOn(mutableChildProcess, "execFileSync"));
      const fork = spies.use(vi.spyOn(mutableChildProcess, "fork"));
      const worker = spies.use(vi.spyOn(mutableWorkers, "Worker"));
      NodeModule.syncBuiltinESMExports();
      try {
        const target = NodePath.join(dir, "target.sqlite");
        yield* createTarget(target);
        edit(target, (db) => {
          const supportsInstructions = Object.hasOwn(
            Contracts.ApplicationProjectCreatedPayload.fields,
            "additionalInstructions",
          );
          expect(
            db
              .prepare("PRAGMA table_info(projection_projects)")
              .all()
              .some((row) => row.name === "additional_instructions"),
          ).toBe(supportsInstructions);
          if (supportsInstructions)
            expect(
              db
                .prepare("SELECT migration_id FROM yngatech_sql_migrations")
                .all()
                .map((row) => row.migration_id),
            ).toEqual([3, 17]);
          expect(
            Number(db.prepare("SELECT max(migration_id) AS n FROM effect_sql_migrations").get()!.n),
          ).toBeGreaterThanOrEqual(117);
          expect(
            db.prepare("SELECT count(*) AS n FROM orchestration_v2_projection_threads").get()!.n,
          ).toBe(0);
        });
        for (const spy of [
          listen,
          spawn,
          spawnSync,
          exec,
          execFile,
          execSync,
          execFileSync,
          fork,
          worker,
        ])
          expect(spy).not.toHaveBeenCalled();
        const before = hash(file);
        expect(Exit.isFailure(yield* Effect.exit(createTarget(file)))).toBe(true);
        expect(hash(file)).toBe(before);
      } finally {
        spies.dispose();
        NodeModule.syncBuiltinESMExports();
      }
    }).pipe(Effect.scoped),
  );
});
