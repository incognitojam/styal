import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as PruneSafety from "../persistence/preEventPruneSafety.ts";
import * as TestClock from "effect/testing/TestClock";

import * as BootService from "../cloud/bootService.ts";
import { runDoctor } from "./doctor.ts";
import * as DatabaseMaintenance from "../persistence/DatabaseMaintenance.ts";
import * as ProcessRunner from "../processRunner.ts";
import { acquireServerOwnership } from "../serverOwnership.ts";
import { makePersistedServerRuntimeState } from "../serverRuntimeState.ts";

// An empty home, so no boot service unit installed on this machine is read.
const layerHost = Layer.mergeAll(
  ProcessRunner.layer,
  Layer.effect(
    HostProcess.HomeDirectory,
    Effect.gen(function* () {
      return yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    }),
  ),
  Layer.succeed(HostProcess.Environment, {}),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

// The doctor reads service.env from the home above userdata, so each test gets an empty home.
const makeHomePaths = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "styal-doctor-" });
  const stateDir = path.join(home, "userdata");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  return {
    dbPath: path.join(stateDir, "statev2.sqlite"),
    serverRuntimeStatePath: path.join(stateDir, "server-runtime.json"),
  };
});

it.effect(
  "--fix locks the home while the service is paused, names a server that holds it, never offers or deletes the V1 database, and --dry-run changes nothing",
  () =>
    Effect.gen(function* () {
      const paths = yield* makeHomePaths;
      const { serverRuntimeStatePath } = paths;
      const calls: string[] = [];
      const printed: string[] = [];
      const services =
        yield* Effect.context<Effect.Services<ReturnType<typeof acquireServerOwnership>>>();
      // Stands in for a server launched for the same home, for example over SSH.
      const startServer = Effect.scoped(acquireServerOwnership(serverRuntimeStatePath)).pipe(
        Effect.result,
        Effect.map((result) =>
          calls.push(result._tag === "Success" ? "server started" : result.failure._tag),
        ),
        Effect.provide(services),
      );
      const doctor = (options: {
        fix: boolean;
        dryRun: boolean;
        interactive: boolean;
        reclaimableBytes: number;
      }) =>
        runDoctor(paths, options).pipe(
          Effect.provideService(Console.Console, {
            ...globalThis.console,
            log: (...args: ReadonlyArray<unknown>) => {
              printed.push(args.join(" "));
            },
          }),
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(BootService.BootService)({
                withStopped: (operation) =>
                  Effect.sync(() => calls.push("pause")).pipe(
                    Effect.andThen(operation),
                    Effect.ensuring(Effect.sync(() => calls.push("resume"))),
                  ),
              }),
              Layer.succeed(DatabaseMaintenance.DatabaseMaintenance, {
                inspect: () =>
                  Effect.succeed({
                    databaseBytes: 2000,
                    reclaimableBytes: options.reclaimableBytes,
                    incrementalVacuumEnabled: options.reclaimableBytes === 0,
                    legacyDatabaseBytes: 4000,
                  }),
                compact: () =>
                  startServer.pipe(
                    Effect.map(() => {
                      calls.push("compact");
                      return {
                        beforeBytes: 2000,
                        afterBytes: 1000,
                        deletedEventCount: 1,
                        deletedReceiptCount: 0,
                      };
                    }),
                  ),
                removeLegacyDatabase: () => Effect.sync(() => calls.push("remove legacy")),
              }),
            ),
          ),
        );
      yield* doctor({ fix: true, dryRun: true, interactive: false, reclaimableBytes: 1000 });
      assert.deepEqual(calls, []);
      assert.include(printed.join("\n"), "Database from 0.1.0 or earlier: 4 KiB");
      assert.notInclude(printed.join("\n"), "Delete the database");
      yield* doctor({ fix: true, dryRun: false, interactive: false, reclaimableBytes: 1000 });
      yield* startServer;
      assert.deepEqual(calls, [
        "pause",
        "ServerAlreadyRunningError",
        "compact",
        "resume",
        "server started",
      ]);
      // With only the V1 database present, the interactive prompt has nothing to offer.
      calls.length = 0;
      printed.length = 0;
      yield* doctor({ fix: false, dryRun: false, interactive: true, reclaimableBytes: 0 });
      assert.deepEqual(calls, []);
      assert.include(printed, "Nothing to repair.");

      const state = yield* makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: undefined },
        port: 3773,
      });
      const refused = yield* Effect.scoped(
        acquireServerOwnership(serverRuntimeStatePath).pipe(
          Effect.tap((owner) => owner.publish(state)),
          Effect.andThen(
            doctor({ fix: true, dryRun: false, interactive: false, reclaimableBytes: 1000 }),
          ),
        ),
      ).pipe(Effect.flip);
      assert.equal(
        refused.message,
        `Stop styal server process ${state.pid}, which the background service did not start, before repairing the database.`,
      );
      assert.deepEqual(calls, ["pause", "resume"]);
    }).pipe(Effect.provide(layerHost)),
);

it.effect("warns how long reclaiming can take and reports each step with its elapsed time", () =>
  Effect.gen(function* () {
    const steps = [
      ["prune-events", "65 seconds"],
      ["vacuum", "701 seconds"],
      ["rebuild-search", "1 second"],
      ["checkpoint", "1 second"],
    ] as const;
    const paths = yield* makeHomePaths;
    const reclaim = (env: Record<string, string>) => {
      const output: string[] = [];
      return runDoctor(paths, {
        fix: true,
        dryRun: false,
        interactive: false,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(BootService.BootService)({
              withStopped: (operation) =>
                Effect.sync(() => output.push("<pause>")).pipe(
                  Effect.andThen(operation),
                  Effect.ensuring(Effect.sync(() => output.push("<resume>"))),
                ),
            }),
            Layer.succeed(DatabaseMaintenance.DatabaseMaintenance, {
              inspect: () =>
                Effect.succeed({
                  databaseBytes: 12.8 * 1024 ** 3,
                  reclaimableBytes: 0,
                  incrementalVacuumEnabled: false,
                  legacyDatabaseBytes: null,
                }),
              compact: (_databasePath, onStep) =>
                Effect.gen(function* () {
                  for (const [step, duration] of steps) {
                    if (onStep) yield* onStep(step);
                    yield* TestClock.adjust(duration);
                  }
                  return {
                    beforeBytes: 12.8 * 1024 ** 3,
                    afterBytes: 12.8 * 1024 ** 3,
                    deletedEventCount: 0,
                    deletedReceiptCount: 0,
                  };
                }),
              removeLegacyDatabase: () => Effect.void,
            }),
            ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
          ),
        ),
        Effect.provideService(Console.Console, {
          ...globalThis.console,
          log: (...args: ReadonlyArray<unknown>) => {
            output.push(...args.join(" ").split("\n"));
          },
        }),
        Effect.as(output),
      );
    };

    const output = yield* reclaim({ T3CODE_EVENT_PRUNING: "1" });
    const paused = output.indexOf("<pause>");
    const resumed = output.indexOf("<resume>");
    assert.isAbove(paused, -1, "the repair must run with the service paused");
    const beforePause = output.slice(0, paused).join("\n");
    const description = beforePause.slice(beforePause.indexOf("Reclaim database space"));
    assert.include(description, "12.80 GiB", "the repair must state the database size up front");
    assert.match(description, /hour/, "the repair must warn it can take over an hour");
    const progress = output
      .slice(paused + 1, resumed)
      .filter((line) => line.trim() !== "" && !line.trim().startsWith("Done"))
      .map((line) => /\[(\d+:\d{2})\]/.exec(line)?.[1] ?? `unprefixed: ${line}`);
    assert.deepEqual(
      progress,
      ["0:00", "1:05", "12:46", "12:47"],
      "each compaction step must print one line with the elapsed time as it starts",
    );

    // The explicit off switch hides event-removal progress.
    const withoutPruning = (yield* reclaim({ T3CODE_EVENT_PRUNING: "0" })).join("\n");
    assert.notInclude(withoutPruning, "Removing superseded events");
    assert.notInclude(withoutPruning, "superseded events removed");
    assert.include(withoutPruning, "[1:05] Rewriting the database file");
  }).pipe(Effect.provide(layerHost)),
);

it.effect("repair honors the service pruning opt-out after an earlier prune", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scratch = path.resolve(import.meta.dirname, "../../../../.scratch");
    yield* fs.makeDirectory(scratch, { recursive: true });
    const home = yield* fs.makeTempDirectoryScoped({
      directory: scratch,
      prefix: "pruning-doctor-",
    });
    const database = path.join(home, "userdata", "statev2.sqlite");
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA auto_vacuum = NONE`;
      yield* sql`VACUUM`;
      yield* sql`INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version) VALUES
        ('synthetic-doctor-old','project','synthetic-doctor-project',1,'project.updated','1960-01-01','server','{}','{}',2),
        ('synthetic-doctor-head','project','synthetic-doctor-project',2,'project.updated','1960-01-01','server','{}','{}',2)`;
      yield* sql`INSERT OR REPLACE INTO orchestration_v2_projection_metadata (projection_name,schema_version,last_sequence,updated_at) VALUES
        ('thread-projections',1,2,'1960-01-01'),('event-log-prune-mark',1,2,'1960-01-01')`;
      yield* PruneSafety.prepare();
      yield* PruneSafety.deletePassStarted();
      yield* PruneSafety.deletePassFinished();
      assert.isTrue(yield* PruneSafety.canPrune());
    }).pipe(Effect.provide(Sqlite.layerFromPath(database)));
    yield* fs.writeFileString(path.join(home, "service.env"), "T3CODE_EVENT_PRUNING=0\n");
    const backup = path.join(home, "userdata", "backups", "pre-event-prune");
    const recoveryCopy = yield* fs.readFile(path.join(backup, "statev2.sqlite"));
    const recoveryManifest = yield* fs.readFileString(path.join(backup, "manifest.json"));
    const output: string[] = [];
    let pauses = 0;
    yield* runDoctor(
      {
        dbPath: database,
        serverRuntimeStatePath: path.join(home, "userdata", "server-runtime.json"),
      },
      { fix: true, dryRun: false, interactive: false },
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          DatabaseMaintenance.layer,
          Layer.mock(BootService.BootService)({
            withStopped: (operation) =>
              Effect.sync(() => {
                pauses++;
              }).pipe(Effect.andThen(operation)),
          }),
        ),
      ),
      Effect.provideService(Console.Console, {
        ...globalThis.console,
        log: (...args: ReadonlyArray<unknown>) => output.push(args.join(" ")),
      }),
    );
    assert.equal(pauses, 1);
    assert.deepEqual(yield* fs.readFile(path.join(backup, "statev2.sqlite")), recoveryCopy);
    assert.equal(yield* fs.readFileString(path.join(backup, "manifest.json")), recoveryManifest);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(yield* sql`SELECT event_id FROM orchestration_events ORDER BY sequence`, [
        { event_id: "synthetic-doctor-old" },
        { event_id: "synthetic-doctor-head" },
      ]);
      assert.deepEqual(
        yield* sql`SELECT last_sequence,updated_at FROM orchestration_v2_projection_metadata WHERE projection_name='event-log-prune-mark'`,
        [{ last_sequence: 2, updated_at: "1960-01-01" }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: database, readonly: true })));
    assert.notInclude(output.join("\n"), "superseded events removed");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_EVENT_PRUNING: "1" } })),
      ),
    ),
    Effect.scoped,
  ),
);
