// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as StreamCopy from "./startupFileCopy.ts";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "./Sqlite.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Safety from "./preEventPruneSafety.ts";
import { vi } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as Copies from "./databaseFileCopy.ts";
import * as Statement from "effect/sql/Statement";
import * as Maintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ServiceLauncherHostProcess } from "../cloud/serviceLauncherClient.ts";
import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
} from "../cloud/serviceProtocol.ts";
import packageJson from "../../package.json" with { type: "json" };

const pruningEnabled = ConfigProvider.layer(
  ConfigProvider.fromEnv({ env: { T3CODE_EVENT_PRUNING: "1" } }),
);

it.effect("requires a safety copy and retains it until seven days after deletion completes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "pruning-safety-",
    });
    const database = `${root}/statev2.sqlite`;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`VACUUM INTO ${database}`;
    }).pipe(Effect.provide(Sqlite.layerMemory));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
      const backup = `${root}/backups/pre-event-prune`;
      yield* fs.makeDirectory(backup, { recursive: true });
      yield* sql`INSERT INTO orchestration_v2_projection_metadata (projection_name,schema_version,last_sequence,updated_at) VALUES ('pre-event-prune-generation',1,0,'synthetic-generation')`;
      yield* sql`VACUUM INTO ${`${backup}/statev2.sqlite`}`;
      yield* sql`INSERT INTO orchestration_v2_projection_metadata (projection_name,schema_version,last_sequence,updated_at) VALUES ('pre-event-prune-copy',1,0,'synthetic-copy')`;
      const manifest = JSON.stringify({
        copyId: "synthetic-copy",
        generation: "synthetic-generation",
        createdAt: 0,
        method: "copy",
        sourceSize: 1,
        eventHead: 0,
        eventCount: 0,
        threadCount: 0,
      });
      yield* fs.writeFileString(`${backup}/manifest.json`, manifest);
      assert.isTrue(yield* Safety.canPrune());
      yield* TestClock.adjust("8 days");
      assert.isTrue(yield* Safety.canPrune());
      assert.isTrue(yield* fs.exists(`${backup}/statev2.sqlite`));
      yield* sql`INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES ('synthetic:safety:old', 'project', 'synthetic:project', 1, 'project.updated',
        '2020-01-01T00:00:00.000Z', 'server', '{}', '{}', 2),
        ('synthetic:safety:head', 'project', 'synthetic:project', 2, 'project.updated',
        '2020-01-01T00:00:00.000Z', 'server', '{}', '{}', 2)`;
      yield* sql`INSERT OR REPLACE INTO orchestration_v2_projection_metadata
        (projection_name,schema_version,last_sequence,updated_at) VALUES ('thread-projections',1,2,'2020-01-01T00:00:00.000Z'),
        ('event-log-prune-mark',1,2,'1969-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO orchestration_v2_legacy_imports (thread_id,source_updated_at,shell_imported_at,transcript_imported_at,imported_message_count)
        VALUES ('synthetic:import','1969-01-01','1969-01-01','1969-01-01',0)`;
      yield* sql`INSERT INTO orchestration_command_receipts (command_id,aggregate_kind,aggregate_id,accepted_at,result_sequence,status,command_type)
        VALUES ('synthetic:receipt','thread','synthetic:import','1969-01-01',0,'accepted','legacy')`;
      yield* fs.remove(`${backup}/manifest.json`);
      assert.equal((yield* maintenance.pruneEventStore()).deletedEventCount, 0);
      assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM orchestration_events`, [
        { count: 2 },
      ]);
      assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM orchestration_command_receipts`, [
        { count: 1 },
      ]);
      yield* fs.writeFileString(`${backup}/manifest.json`, manifest);
      const deleted = yield* maintenance.pruneEventStore();
      assert.equal(deleted.deletedEventCount, 1);
      assert.equal(deleted.deletedReceiptCount, 1);
      yield* TestClock.adjust("6 days");
      assert.isTrue(yield* Safety.canPrune());
      yield* TestClock.adjust("1 day");
      assert.isTrue(yield* Safety.canPrune());
      assert.isFalse(yield* fs.exists(`${backup}/statev2.sqlite`));
      yield* Safety.prepare();
      assert.isFalse(yield* fs.exists(`${backup}/statev2.sqlite`));
      assert.isTrue(yield* Safety.canPrune());
      assert.isTrue(yield* fs.exists(`${backup}/manifest.json`));
      assert.equal((yield* maintenance.pruneEventStore()).deletedEventCount, 0);
    }).pipe(
      Effect.provide(
        Maintenance.layer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: database }))),
      ),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pruningEnabled))),
);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({
    prefix: "pruning-review-",
  });
  const database = `${root}/statev2.sqlite`;
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`VACUUM INTO ${database}`;
  }).pipe(Effect.provide(Sqlite.layerMemory));
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA journal_mode = WAL`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: database })));
  return { fs, root, database, backup: `${root}/backups/pre-event-prune` };
});
const stoppedFileClone = () =>
  vi.spyOn(Copies, "cloneDatabaseFile").mockImplementation(async (source, destination) => {
    await NodeFSP.copyFile(source, destination, NodeFS.constants.COPYFILE_EXCL);
    return true;
  });

it.effect.each([
  "unpruned",
  "interrupted-adoption",
  "boundary",
  "started",
  "completed",
  "restored",
] as const)("upgrades a legacy manifest with %s history without disabling valid pruning", (state) =>
  Effect.gen(function* () {
    const { fs, database, backup } = yield* fixture;
    using clone = stoppedFileClone();
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Safety.prepare();
      const legacy = JSON.parse(yield* fs.readFileString(`${backup}/manifest.json`));
      delete legacy.copyId;
      const unpruned = state === "unpruned" || state === "interrupted-adoption";
      if (state === "started" || state === "restored") legacy.firstDeleteStartedAt = 0;
      if (state === "completed") legacy.firstDeleteCompletedAt = 0;
      yield* fs.writeFileString(`${backup}/manifest.json`, JSON.stringify(legacy));
      yield* sql`DELETE FROM orchestration_v2_projection_metadata WHERE projection_name='pre-event-prune-copy'`;
      if (state === "boundary" || state === "started" || state === "completed")
        yield* sql`INSERT INTO orchestration_v2_projection_metadata (projection_name,schema_version,last_sequence,updated_at) VALUES ('event-log-pruned-through',1,0,'1970-01-01')`;
      const originalCopy = yield* fs.readFile(`${backup}/statev2.sqlite`);
      if (state === "interrupted-adoption") {
        yield* fs.makeDirectory(`${backup}/manifest.json.staging`);
        yield* Safety.prepare();
        assert.deepEqual(JSON.parse(yield* fs.readFileString(`${backup}/manifest.json`)), legacy);
        assert.lengthOf(
          yield* sql`SELECT updated_at FROM orchestration_v2_projection_metadata WHERE projection_name='pre-event-prune-copy'`,
          1,
        );
        yield* fs.remove(`${backup}/manifest.json.staging`, { recursive: true });
      }
      yield* Safety.prepare();
      assert.equal(yield* Safety.canPrune(), state !== "restored");
      const manifest = JSON.parse(yield* fs.readFileString(`${backup}/manifest.json`));
      if (unpruned) {
        assert.isString(manifest.copyId);
        assert.deepEqual(
          yield* sql`SELECT updated_at FROM orchestration_v2_projection_metadata WHERE projection_name='pre-event-prune-copy'`,
          [{ updated_at: manifest.copyId }],
        );
      } else assert.isUndefined(manifest.copyId);
      assert.deepEqual(yield* fs.readFile(`${backup}/statev2.sqlite`), originalCopy);
      yield* Safety.prepare();
      assert.equal(yield* Safety.canPrune(), state !== "restored");
      assert.equal(clone.mock.calls.length, 1);
      yield* TestClock.adjust("8 days");
      assert.equal(yield* Safety.canPrune(), state !== "restored");
      assert.equal(yield* fs.exists(`${backup}/statev2.sqlite`), state !== "completed");
      if (state === "unpruned") {
        yield* sql`INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version) VALUES
            ('legacy-upgrade:old','project','legacy-upgrade:project',1,'project.updated','2020-01-01','server','{}','{}',2),
            ('legacy-upgrade:head','project','legacy-upgrade:project',2,'project.updated','2020-01-01','server','{}','{}',2)`;
        yield* sql`INSERT OR REPLACE INTO orchestration_v2_projection_metadata (projection_name,schema_version,last_sequence,updated_at) VALUES ('thread-projections',1,2,'2020-01-01'),('event-log-prune-mark',1,2,'1969-01-01')`;
        const result = yield* Effect.gen(function* () {
          const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
          return yield* maintenance.pruneEventStore();
        }).pipe(Effect.provide(Maintenance.layer));
        assert.equal(result.deletedEventCount, 1);
      }
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: database })));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pruningEnabled))),
);

it.effect.each([undefined, "previous-copy"])(
  "detects a restored already-pruned copy containing marker %s",
  (previousCopy) =>
    Effect.gen(function* () {
      const { fs, database, backup } = yield* fixture;
      const warnings: unknown[] = [];
      const logger = Logger.layer(
        [
          Logger.make(({ message, logLevel }) => {
            if (logLevel === "Warn") warnings.push(message);
          }),
        ],
        { mergeWithExisting: false },
      );
      using clone = stoppedFileClone();
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_metadata (projection_name,schema_version,last_sequence,updated_at) VALUES ('event-log-pruned-through',1,42,'2020-01-01')`;
        if (previousCopy !== undefined)
          yield* sql`INSERT INTO orchestration_v2_projection_metadata (projection_name,schema_version,last_sequence,updated_at) VALUES ('pre-event-prune-copy',1,0,${previousCopy})`;
        yield* Safety.prepare();
        yield* Safety.prepare();
        assert.isTrue(yield* Safety.canPrune());
        assert.equal(clone.mock.calls.length, 1);
        assert.deepEqual(warnings, []);
        yield* Safety.deletePassStarted();
        yield* Safety.deletePassFinished();
      }).pipe(Effect.provide(Layer.merge(NodeSqliteClient.layer({ filename: database }), logger)));
      yield* Effect.gen(function* () {
        yield* Safety.prepare();
        assert.isTrue(yield* Safety.canPrune());
        assert.equal(clone.mock.calls.length, 1);
        assert.deepEqual(warnings, []);
      }).pipe(Effect.provide(Layer.merge(NodeSqliteClient.layer({ filename: database }), logger)));
      yield* Effect.promise(() => NodeFSP.copyFile(`${backup}/statev2.sqlite`, database));
      for (const suffix of ["-wal", "-shm"])
        yield* Effect.promise(() => NodeFSP.rm(`${database}${suffix}`, { force: true }));
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.equal(
          (yield* sql`SELECT last_sequence FROM orchestration_v2_projection_metadata WHERE projection_name='event-log-pruned-through'`)[0]
            ?.last_sequence,
          42,
        );
        assert.isFalse(yield* Safety.canPrune());
        yield* TestClock.adjust("8 days");
        assert.isFalse(yield* Safety.canPrune());
        yield* Safety.prepare();
        assert.equal(clone.mock.calls.length, 1);
        assert.isTrue(yield* fs.exists(`${backup}/statev2.sqlite`));
        assert.include(JSON.stringify(warnings), "Restored database detected");
      }).pipe(Effect.provide(Layer.merge(NodeSqliteClient.layer({ filename: database }), logger)));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pruningEnabled))),
);

it.effect.each(["manifest", "copy"] as const)(
  "retries a crash before publishing the %s after writing the identity",
  (publication) =>
    Effect.gen(function* () {
      const { fs, database, backup } = yield* fixture;
      using clone = stoppedFileClone();
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_metadata (projection_name,schema_version,last_sequence,updated_at) VALUES ('event-log-pruned-through',1,42,'2020-01-01')`;
        const blocker = `${backup}/${publication === "manifest" ? "manifest.json.staging" : "statev2.sqlite"}`;
        clone.mockImplementationOnce(async (source, target) => {
          await NodeFSP.copyFile(source, target, NodeFS.constants.COPYFILE_EXCL);
          await NodeFSP.mkdir(blocker);
          return true;
        });
        yield* Safety.prepare();
        yield* fs.remove(blocker, { recursive: true });
        assert.isFalse(yield* fs.exists(`${backup}/statev2.sqlite`));
        assert.equal(yield* fs.exists(`${backup}/manifest.json`), publication === "copy");
        const before =
          yield* sql`SELECT updated_at FROM orchestration_v2_projection_metadata WHERE projection_name='pre-event-prune-copy'`;
        assert.lengthOf(before, 1);
        assert.isFalse(yield* Safety.canPrune());
        yield* Safety.prepare();
        assert.isTrue(yield* Safety.canPrune());
        assert.isTrue(yield* fs.exists(`${backup}/statev2.sqlite`));
        assert.notDeepEqual(
          yield* sql`SELECT updated_at FROM orchestration_v2_projection_metadata WHERE projection_name='pre-event-prune-copy'`,
          before,
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: database })));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pruningEnabled))),
);

it.effect("disabled pruning makes no copy, disk check, progress report or metadata change", () =>
  Effect.gen(function* () {
    const { fs, database, backup } = yield* fixture;
    let copyWork = 0;
    let reports = 0;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
      const metadata = yield* sql`SELECT * FROM orchestration_v2_projection_metadata`;
      yield* Safety.prepare().pipe(
        Effect.provideService(Safety.Preparation, {
          clone: async () => {
            copyWork++;
            return false;
          },
          freeBytes: async () => {
            copyWork++;
            return 0;
          },
        }),
        Effect.provideService(Safety.Progress, () =>
          Effect.sync(() => {
            reports++;
          }),
        ),
      );
      assert.deepEqual(yield* maintenance.pruneEventStore(), {
        deletedEventCount: 0,
        deletedReceiptCount: 0,
        reclaimableBytes: 0,
      });
      assert.equal(copyWork, 0);
      assert.equal(reports, 0);
      assert.isFalse(yield* fs.exists(backup));
      assert.deepEqual(yield* sql`SELECT * FROM orchestration_v2_projection_metadata`, metadata);
    }).pipe(
      Effect.provide(
        Maintenance.layer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: database }))),
      ),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
    ),
  ),
);

it.effect("ordinary SQLite callers do not prepare a pruning copy", () =>
  Effect.gen(function* () {
    const { fs, database, backup } = yield* fixture;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(
        yield* sql`SELECT projection_name FROM orchestration_v2_projection_metadata WHERE projection_name = 'pre-event-prune-generation'`,
        [],
      );
      assert.isFalse(yield* fs.exists(backup));
    }).pipe(Effect.provide(Sqlite.layerFromPath(database)));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pruningEnabled))),
);

it.effect("defers trial copying and pruning until the next ordinary service start", () =>
  Effect.gen(function* () {
    const { fs, database, backup } = yield* fixture;
    using clone = stoppedFileClone();
    const update = {
      id: "synthetic-update",
      fromVersion: "0.0.1",
      targetVersion: packageJson.version,
    };
    const environment = (status: "pending" | "committed") => ({
      [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        childVersion: packageJson.version,
        update: { ...update, status, ...(status === "pending" ? { dbPath: database } : {}) },
      }),
    });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES ('trial:old', 'project', 'trial:project', 1, 'project.updated',
        '2020-01-01', 'server', '{}', '{}', 2),
        ('trial:head', 'project', 'trial:project', 2, 'project.updated',
        '2020-01-01', 'server', '{}', '{}', 2)`;
      yield* sql`INSERT OR REPLACE INTO orchestration_v2_projection_metadata
        (projection_name,schema_version,last_sequence,updated_at) VALUES
        ('thread-projections',1,2,'2020-01-01'), ('event-log-prune-mark',1,2,'1969-01-01')`;
      yield* sql`INSERT INTO orchestration_v2_legacy_imports
        (thread_id,source_updated_at,shell_imported_at,transcript_imported_at)
        VALUES ('trial:import','2020-01-01','2020-01-01','2020-01-01')`;
      yield* sql`INSERT INTO orchestration_command_receipts
        (command_id,aggregate_kind,aggregate_id,accepted_at,result_sequence,status,command_type)
        VALUES ('trial:receipt','thread','trial:import','2020-01-01',0,'accepted','legacy')`;
      const metadata = yield* sql`SELECT * FROM orchestration_v2_projection_metadata`;
      yield* Safety.prepare();
      const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
      assert.deepEqual(yield* maintenance.pruneEventStore(), {
        deletedEventCount: 0,
        deletedReceiptCount: 0,
        reclaimableBytes: 0,
      });
      assert.equal(clone.mock.calls.length, 0);
      assert.isFalse(yield* fs.exists(backup));
      assert.deepEqual(yield* sql`SELECT * FROM orchestration_v2_projection_metadata`, metadata);
      assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM orchestration_events`, [
        { count: 2 },
      ]);
      assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM orchestration_command_receipts`, [
        { count: 1 },
      ]);
    }).pipe(
      Effect.provide(
        Maintenance.layer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: database }))),
      ),
      Effect.provideService(HostProcess.Environment, environment("pending")),
    );
    yield* Effect.gen(function* () {
      yield* Safety.prepare();
      assert.equal(clone.mock.calls.length, 1);
      assert.isTrue(yield* fs.exists(`${backup}/statev2.sqlite`));
      assert.isTrue(yield* Safety.canPrune());
      assert.isFalse(
        yield* Safety.canPrune().pipe(
          Effect.provideService(HostProcess.Environment, environment("pending")),
        ),
      );
      const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
      assert.equal((yield* maintenance.pruneEventStore()).deletedEventCount, 1);
    }).pipe(
      Effect.provide(
        Maintenance.layer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: database }))),
      ),
      Effect.provideService(HostProcess.Environment, environment("committed")),
    );
  }).pipe(
    Effect.provideService(ServiceLauncherHostProcess, {
      connected: true,
      send: () => false,
      on: () => {},
      off: () => {},
    }),
    Effect.provide(Layer.mergeAll(NodeServices.layer, pruningEnabled)),
  ),
);

it.effect("a restored database pauses pruning and preserves its recovery copy past expiry", () =>
  Effect.gen(function* () {
    const { fs, database, backup } = yield* fixture;
    yield* Effect.gen(function* () {
      using _clone = stoppedFileClone();
      yield* Safety.prepare();
      const manifest = JSON.parse(yield* fs.readFileString(`${backup}/manifest.json`));
      yield* fs.writeFileString(
        `${backup}/manifest.json`,
        JSON.stringify({ ...manifest, firstDeleteCompletedAt: 0 }),
      );
      assert.isFalse(yield* Safety.canPrune());
      yield* TestClock.adjust("8 days");
      assert.isFalse(yield* Safety.canPrune());
      yield* Safety.prepare();
      assert.isTrue(yield* fs.exists(`${backup}/statev2.sqlite`));
      assert.deepEqual(JSON.parse(yield* fs.readFileString(`${backup}/manifest.json`)), {
        ...manifest,
        firstDeleteCompletedAt: 0,
      });
      yield* fs.remove(backup, { recursive: true });
      yield* Safety.prepare();
      assert.isTrue(yield* Safety.canPrune());
      assert.isTrue(yield* fs.exists(`${backup}/statev2.sqlite`));
      assert.isUndefined(
        JSON.parse(yield* fs.readFileString(`${backup}/manifest.json`)).firstDeleteCompletedAt,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: database })));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pruningEnabled))),
);

it.effect("removes a killed attempt's staging file before the next clone", () =>
  Effect.gen(function* () {
    const { fs, database, backup } = yield* fixture;
    yield* fs.makeDirectory(backup, { recursive: true });
    yield* fs.writeFileString(`${backup}/statev2.sqlite.staging`, "stale attempt");
    yield* fs.writeFileString(`${backup}/statev2.sqlite.staging-journal`, "stale journal");
    yield* Effect.gen(function* () {
      using _clone = stoppedFileClone();
      yield* Safety.prepare();
      assert.isTrue(yield* fs.exists(`${backup}/manifest.json`));
      assert.isFalse(yield* fs.exists(`${backup}/statev2.sqlite.staging`));
      assert.isFalse(yield* fs.exists(`${backup}/statev2.sqlite.staging-journal`));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: database })));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pruningEnabled))),
);

it.effect("replaces a rollback trial copy only when neither side records deletion", () =>
  Effect.gen(function* () {
    const { fs, database, backup } = yield* fixture;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      using clone = stoppedFileClone();
      yield* Safety.prepare();
      const oldManifest = yield* fs.readFileString(`${backup}/manifest.json`);
      const oldBytes = yield* fs.readFile(`${backup}/statev2.sqlite`);
      yield* sql`DELETE FROM orchestration_v2_projection_metadata WHERE projection_name = 'pre-event-prune-generation'`;
      clone.mockRejectedValueOnce(new Error("synthetic clone failure"));
      yield* Safety.prepare();
      assert.deepEqual(yield* fs.readFile(`${backup}/statev2.sqlite`), oldBytes);
      assert.equal(yield* fs.readFileString(`${backup}/manifest.json`), oldManifest);
      clone.mockImplementationOnce(async (source, destination) => {
        await NodeFSP.copyFile(source, destination, NodeFS.constants.COPYFILE_EXCL);
        await NodeFSP.mkdir(`${backup}/manifest.json.staging`);
        return true;
      });
      yield* Safety.prepare();
      assert.deepEqual(yield* fs.readFile(`${backup}/statev2.sqlite`), oldBytes);
      assert.equal(yield* fs.readFileString(`${backup}/manifest.json`), oldManifest);
      yield* fs.remove(`${backup}/manifest.json.staging`, { recursive: true });
      yield* Safety.prepare();
      const replacement = JSON.parse(yield* fs.readFileString(`${backup}/manifest.json`));
      assert.notEqual(replacement.generation, JSON.parse(oldManifest).generation);
      assert.isTrue(yield* Safety.canPrune());
      const replacementBytes = yield* fs.readFile(`${backup}/statev2.sqlite`);
      yield* fs.writeFileString(
        `${backup}/manifest.json`,
        JSON.stringify({ ...replacement, firstDeleteCompletedAt: 0 }),
      );
      yield* sql`DELETE FROM orchestration_v2_projection_metadata WHERE projection_name = 'pre-event-prune-generation'`;
      yield* Safety.prepare();
      assert.equal(
        JSON.parse(yield* fs.readFileString(`${backup}/manifest.json`)).generation,
        replacement.generation,
      );
      assert.isFalse(yield* Safety.canPrune());
      assert.deepEqual(yield* fs.readFile(`${backup}/statev2.sqlite`), replacementBytes);
      yield* fs.writeFileString(`${backup}/manifest.json`, JSON.stringify(replacement));
      yield* sql`INSERT INTO orchestration_v2_projection_metadata (projection_name,schema_version,last_sequence,updated_at) VALUES ('event-log-pruned-through',1,1,'1970-01-01T00:00:00.000Z')`;
      yield* Safety.prepare();
      assert.equal(
        JSON.parse(yield* fs.readFileString(`${backup}/manifest.json`)).generation,
        replacement.generation,
      );
      assert.isFalse(yield* Safety.canPrune());
      assert.deepEqual(yield* fs.readFile(`${backup}/statev2.sqlite`), replacementBytes);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: database })));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pruningEnabled))),
);

it("requires exact event and thread counts for every startup copy", () => {
  const before = { eventCount: 10, eventHead: 15, threadCount: 2 };
  assert.isTrue(Safety.copyIsConsistent(before, before, before));
  for (const field of ["eventCount", "eventHead", "threadCount"] as const) {
    assert.isFalse(
      Safety.copyIsConsistent(before, { ...before, [field]: before[field] - 1 }, before),
    );
    assert.isFalse(
      Safety.copyIsConsistent(before, before, { ...before, [field]: before[field] + 1 }),
    );
  }
});

it.effect("a stalled copy records a seven-day retry delay without authorizing pruning", () =>
  Effect.gen(function* () {
    const { fs, database, backup } = yield* fixture;
    yield* Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const options: Safety.PreparationOptions = {
        clone: async () => false,
        stream: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      };
      const first = yield* Safety.prepare().pipe(
        Effect.provideService(Safety.Preparation, options),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("60 seconds");
      yield* Fiber.join(first);
      assert.isFalse(yield* Safety.canPrune());
      assert.isFalse(yield* fs.exists(`${backup}/manifest.json`));
      assert.isTrue(yield* fs.exists(`${backup}/last-attempt.json`));
      yield* Safety.prepare().pipe(
        Effect.provideService(Safety.Preparation, { clone: async () => false }),
      );
      assert.isFalse(yield* fs.exists(`${backup}/manifest.json`));
      yield* TestClock.adjust("7 days");
      yield* Safety.prepare().pipe(
        Effect.provideService(Safety.Preparation, { clone: async () => false }),
      );
      assert.isTrue(yield* Safety.canPrune());
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: database })));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pruningEnabled))),
);

it.effect("quitting removes staging and permits an immediate retry", () =>
  Effect.gen(function* () {
    const { fs, database, backup } = yield* fixture;
    yield* Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const options: Safety.PreparationOptions = {
        clone: async () => false,
        stream: (_source, destination) =>
          Effect.gen(function* () {
            yield* fs.writeFileString(destination, "incomplete synthetic copy").pipe(Effect.orDie);
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }),
      };
      const first = yield* Safety.prepare().pipe(
        Effect.provideService(Safety.Preparation, options),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(first);
      assert.isFalse(yield* fs.exists(`${backup}/statev2.sqlite.staging`));
      assert.isFalse(yield* fs.exists(`${backup}/manifest.json`));
      assert.isFalse(yield* fs.exists(`${backup}/last-attempt.json`));
      assert.isFalse(yield* Safety.canPrune());
      yield* Safety.prepare().pipe(
        Effect.provideService(Safety.Preparation, { clone: async () => false }),
      );
      assert.isTrue(yield* Safety.canPrune());
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: database })));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pruningEnabled))),
);

it.effect("low space and ENOSPC leave pruning disabled and retry on the next start", () =>
  Effect.gen(function* () {
    const { fs, database, backup } = yield* fixture;
    yield* Effect.gen(function* () {
      yield* Safety.prepare().pipe(
        Effect.provideService(Safety.Preparation, {
          clone: async () => false,
          freeBytes: async () => 0,
        }),
      );
      assert.isFalse(yield* Safety.canPrune());
      assert.isFalse(yield* fs.exists(`${backup}/last-attempt.json`));
      yield* Safety.prepare().pipe(
        Effect.provideService(Safety.Preparation, {
          clone: async () => false,
          stream: (_source, destination) =>
            Effect.gen(function* () {
              yield* fs.writeFileString(destination, "partial copy").pipe(Effect.orDie);
              return yield* new StreamCopy.StartupCopyIoError({
                cause: "ENOSPC: synthetic full disk",
              });
            }),
        }),
      );
      assert.isFalse(yield* Safety.canPrune());
      assert.isFalse(yield* fs.exists(`${backup}/statev2.sqlite.staging`));
      assert.isFalse(yield* fs.exists(`${backup}/last-attempt.json`));
      yield* Safety.prepare().pipe(
        Effect.provideService(Safety.Preparation, { clone: async () => false }),
      );
      assert.isTrue(yield* Safety.canPrune());
      const manifest = JSON.parse(yield* fs.readFileString(`${backup}/manifest.json`));
      assert.equal(manifest.method, "copy");
      assert.equal(manifest.eventCount, 0);
      assert.equal(manifest.threadCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: database })));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pruningEnabled))),
);

it.effect.each(["missing-manifest", "size", "wal", "interrupted-delete"] as const)(
  "preserves recovery history when %s",
  (damage) =>
    Effect.gen(function* () {
      const { fs, database, backup } = yield* fixture;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        using clone = stoppedFileClone();
        if (damage === "size" || damage === "wal") {
          clone.mockImplementation(async (source, destination) => {
            await NodeFSP.copyFile(source, destination);
            if (damage === "size") await NodeFSP.appendFile(destination, new Uint8Array(4096));
            else await NodeFSP.writeFile(`${source}-wal`, new Uint8Array(32));
            return true;
          });
          yield* Safety.prepare();
          assert.isFalse(yield* fs.exists(`${backup}/manifest.json`));
          assert.isFalse(yield* Safety.canPrune());
          return;
        }
        yield* Safety.prepare();
        const original = yield* fs.readFile(`${backup}/statev2.sqlite`);
        if (damage === "missing-manifest") {
          yield* sql`INSERT INTO orchestration_v2_projection_metadata (projection_name,schema_version,last_sequence,updated_at) VALUES ('event-log-pruned-through',1,0,'2020-01-01')`;
          yield* fs.remove(`${backup}/manifest.json`);
          yield* Safety.prepare();
          assert.deepEqual(yield* fs.readFile(`${backup}/statev2.sqlite`), original);
          assert.equal(clone.mock.calls.length, 1);
          assert.isFalse(yield* Safety.canPrune());
          return;
        }
        yield* sql`INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version) VALUES
        ('interrupt:old','project','project:interrupt',1,'project.updated','2020-01-01','server','{}','{}',2),
        ('interrupt:head','project','project:interrupt',2,'project.updated','2020-01-01','server','{}','{}',2)`;
        yield* sql`INSERT OR REPLACE INTO orchestration_v2_projection_metadata (projection_name,schema_version,last_sequence,updated_at) VALUES ('thread-projections',1,2,'2020-01-01'),('event-log-prune-mark',1,2,'1969-01-01')`;
        const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
        const interrupt: Statement.Transformer = (statement) =>
          /^\s*DELETE FROM orchestration_events/.test(statement.compile()[0])
            ? Effect.die("synthetic interruption")
            : Effect.succeed(statement);
        yield* maintenance
          .pruneEventStore()
          .pipe(Effect.provideService(Statement.CurrentTransformer, interrupt), Effect.exit);
        const manifest = JSON.parse(yield* fs.readFileString(`${backup}/manifest.json`));
        assert.isNumber(manifest.firstDeleteStartedAt);
        assert.isUndefined(manifest.firstDeleteCompletedAt);
        assert.isTrue(yield* Safety.canPrune());
        yield* sql`DELETE FROM orchestration_v2_projection_metadata WHERE projection_name='event-log-pruned-through'`;
        assert.isFalse(yield* Safety.canPrune());
        yield* TestClock.adjust("8 days");
        assert.isFalse(yield* Safety.canPrune());
        assert.isTrue(yield* fs.exists(`${backup}/statev2.sqlite`));
      }).pipe(
        Effect.provide(
          Maintenance.layer.pipe(
            Layer.provideMerge(NodeSqliteClient.layer({ filename: database })),
          ),
        ),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pruningEnabled))),
);

it.effect("commits the delete marker durably before publishing delete-start", () =>
  Effect.gen(function* () {
    const { fs, database, backup } = yield* fixture;
    yield* Effect.gen(function* () {
      using _clone = stoppedFileClone();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA synchronous = NORMAL`;
      yield* Safety.prepare();
      yield* sql`INSERT INTO orchestration_v2_projection_metadata (projection_name,schema_version,last_sequence,updated_at) VALUES ('event-log-pruned-through',1,42,'1970-01-01T00:00:00.000Z')`;
      const connection = yield* sql.reserve.pipe(Effect.scoped);
      const execute = connection.execute;
      const modes: unknown[] = [];
      using _execute = vi.spyOn(connection, "execute").mockImplementation((query, params, rows) =>
        Effect.gen(function* () {
          if (query.startsWith("INSERT") && query.includes("event-log-pruned-through")) {
            modes.push(yield* connection.executeValues("PRAGMA synchronous", []));
            modes.push(yield* connection.executeValues("PRAGMA fullfsync", []));
            assert.isUndefined(
              JSON.parse(yield* fs.readFileString(`${backup}/manifest.json`).pipe(Effect.orDie))
                .firstDeleteStartedAt,
            );
          }
          return yield* execute(query, params, rows);
        }),
      );
      yield* Safety.deletePassStarted();
      assert.deepEqual(modes, [[[2]], [[1]]]);
      assert.deepEqual(
        yield* sql`SELECT last_sequence,updated_at FROM orchestration_v2_projection_metadata WHERE projection_name='event-log-pruned-through'`,
        [{ last_sequence: 42, updated_at: "1970-01-01T00:00:00.001Z" }],
      );
      assert.deepEqual(yield* sql`PRAGMA synchronous`, [{ synchronous: 1 }]);
      assert.isTrue(yield* Safety.canPrune());
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: database })));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pruningEnabled))),
);

it.effect("warns when a retained manifest has lost its copy", () =>
  Effect.gen(function* () {
    const { fs, database, backup } = yield* fixture;
    const warnings: unknown[] = [];
    yield* Effect.gen(function* () {
      using _clone = stoppedFileClone();
      yield* Safety.prepare();
      yield* Safety.deletePassStarted();
      yield* fs.remove(`${backup}/statev2.sqlite`);
      assert.isFalse(yield* Safety.canPrune());
      assert.include(JSON.stringify(warnings), "Recovery copy is missing");
      warnings.length = 0;
      yield* Safety.prepare();
      assert.isFalse(yield* fs.exists(`${backup}/statev2.sqlite`));
    }).pipe(
      Effect.provide(
        Layer.merge(
          NodeSqliteClient.layer({ filename: database }),
          Logger.layer(
            [
              Logger.make(({ message, logLevel }) => {
                if (logLevel === "Warn") warnings.push(message);
              }),
            ],
            { mergeWithExisting: false },
          ),
        ),
      ),
    );
    assert.include(JSON.stringify(warnings), "Recovery copy is missing");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pruningEnabled))),
);

it.effect.each(["inspection", "clone", "verification"] as const)(
  "names %s timeouts and retries at the next startup without a give-up record",
  (phase) =>
    Effect.gen(function* () {
      const { fs, database, backup } = yield* fixture;
      const warnings: unknown[] = [];
      const started = Promise.withResolvers<void>();
      const pending = () => {
        started.resolve();
        return new Promise<never>(() => {});
      };
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        if (phase === "verification") {
          yield* sql`INSERT INTO orchestration_v2_projection_metadata (projection_name,schema_version,last_sequence,updated_at) VALUES ('pre-event-prune-generation',1,0,'synthetic-verification')`;
          yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
        }
        const first = yield* Safety.prepare().pipe(
          Effect.provideService(
            Safety.Preparation,
            phase === "verification"
              ? {
                  clone: async () => false,
                  inspect: (_database, checkpoint) =>
                    checkpoint
                      ? Promise.resolve({ eventCount: 0, eventHead: 0, threadCount: 0 })
                      : pending(),
                }
              : phase === "inspection"
                ? { inspect: pending }
                : { clone: pending },
          ),
          Effect.forkChild,
        );
        yield* Effect.promise(() => started.promise);
        yield* TestClock.adjust(phase === "clone" ? "119 seconds" : "59 seconds");
        assert.isUndefined(first.pollUnsafe());
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(first);
        assert.include(
          JSON.stringify(warnings),
          phase === "clone"
            ? "clone and verification exceeded 120 seconds"
            : "inspection exceeded the 60-second startup budget",
        );
        assert.isFalse(yield* fs.exists(`${backup}/last-attempt.json`));
        assert.isFalse(yield* Safety.canPrune());
        using clone = stoppedFileClone();
        yield* Safety.prepare();
        assert.equal(clone.mock.calls.length, 1);
        assert.isTrue(yield* Safety.canPrune());
      }).pipe(
        Effect.provide(
          Layer.merge(
            NodeSqliteClient.layer({ filename: database }),
            Logger.layer(
              [
                Logger.make(({ message, logLevel }) => {
                  if (logLevel === "Warn") warnings.push(message);
                }),
              ],
              { mergeWithExisting: false },
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pruningEnabled))),
);
