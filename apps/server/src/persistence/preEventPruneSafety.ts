// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeWorkerThreads from "node:worker_threads";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { eventPruningEnabled } from "../config.ts";
import { resolveServiceLauncherMode } from "../cloud/serviceLauncherClient.ts";
import { cloneDatabaseFile, databaseCopyHeadroom } from "./databaseFileCopy.ts";
import * as Context from "effect/Context";
import { STARTUP_COPY_MESSAGE, type ServerStartupCopyProgress } from "@t3tools/contracts";
import { streamDatabaseFile, withCopyBudget, type StartupCopyLimit } from "./startupFileCopy.ts";

export interface PreparationOptions {
  readonly clone?: typeof cloneDatabaseFile;
  readonly freeBytes?: (directory: string) => Promise<number>;
  readonly stream?: typeof streamDatabaseFile;
}
export class Preparation extends Context.Reference<PreparationOptions>(
  "styal/PrePrunePreparation",
  {
    defaultValue: () => ({}),
  },
) {}
export class Progress extends Context.Reference<
  (progress: ServerStartupCopyProgress | null) => Effect.Effect<void>
>("styal/PrePruneProgress", { defaultValue: () => () => Effect.void }) {}

class SafetyCopyError extends Data.TaggedError("SafetyCopyError")<{ readonly cause: unknown }> {}

const GENERATION = "pre-event-prune-generation";
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const paths = (database: string) => {
  const directory = NodePath.join(NodePath.dirname(database), "backups", "pre-event-prune");
  return {
    directory,
    copy: NodePath.join(directory, "statev2.sqlite"),
    manifest: NodePath.join(directory, "manifest.json"),
  };
};
interface Manifest {
  generation: string;
  createdAt: number;
  method: "clone" | "copy";
  sourceSize: number;
  eventHead: number;
  eventCount: number;
  threadCount: number;
  firstDeleteStartedAt?: number;
  firstDeleteCompletedAt?: number;
}
export interface CopySnapshot {
  readonly eventCount: number;
  readonly eventHead: number;
  readonly threadCount: number;
}
export const copyIsConsistent = (before: CopySnapshot, copy: CopySnapshot, after: CopySnapshot) =>
  before.eventHead === copy.eventHead &&
  copy.eventHead === after.eventHead &&
  before.eventCount === copy.eventCount &&
  copy.eventCount === after.eventCount &&
  before.threadCount === copy.threadCount &&
  copy.threadCount === after.threadCount;
const copyExists = async (database: string) =>
  (await NodeFSP.stat(paths(database).copy).catch(() => undefined))?.isFile() ?? false;
const readManifest = async (database: string): Promise<Manifest | undefined> => {
  try {
    const value: unknown = JSON.parse(await NodeFSP.readFile(paths(database).manifest, "utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Partial<Manifest>;
    if (
      typeof record.generation !== "string" ||
      typeof record.createdAt !== "number" ||
      (record.method !== "clone" && record.method !== "copy") ||
      typeof record.eventHead !== "number" ||
      typeof record.eventCount !== "number" ||
      typeof record.threadCount !== "number" ||
      typeof record.sourceSize !== "number" ||
      (record.firstDeleteStartedAt !== undefined &&
        typeof record.firstDeleteStartedAt !== "number") ||
      (record.firstDeleteCompletedAt !== undefined &&
        typeof record.firstDeleteCompletedAt !== "number")
    )
      return undefined;
    return record as Manifest;
  } catch {
    return undefined;
  }
};
const sync = async (file: string) => {
  const handle = await NodeFSP.open(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};
const syncDirectory = async (directory: string) => {
  let handle;
  try {
    handle = await NodeFSP.open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EINVAL" && code !== "EISDIR") throw error;
  } finally {
    await handle?.close();
  }
};
const writeManifest = async (database: string, manifest: Manifest, signal?: AbortSignal) => {
  const target = paths(database).manifest;
  await NodeFSP.writeFile(`${target}.staging`, JSON.stringify(manifest), { mode: 0o600 });
  await sync(`${target}.staging`);
  signal?.throwIfAborted();
  await NodeFSP.rename(`${target}.staging`, target);
  await syncDirectory(paths(database).directory);
};

// Bound startup I/O independently of the synchronous writer and desktop readiness.
const inspect = (
  database: string,
  checkpoint = false,
  signal?: AbortSignal,
): Promise<CopySnapshot> =>
  new Promise((resolve, reject) => {
    const worker = new NodeWorkerThreads.Worker(
      `
      const {parentPort,workerData}=require('node:worker_threads');
      const {DatabaseSync}=require('node:sqlite');
      try {
        const db=new DatabaseSync(workerData.database,{readOnly:!workerData.checkpoint});
        db.exec('PRAGMA busy_timeout=5000');
        if(workerData.checkpoint){
          const result=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
          if(result.busy!==0 || result.log!==0 || result.checkpointed!==0) throw new Error('WAL did not fully truncate');
        }
        db.exec("BEGIN");
        const result={
          eventCount:db.prepare('SELECT COUNT(*) AS n FROM orchestration_events').get().n,
          eventHead:db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM orchestration_events').get().n,
          threadCount:db.prepare('SELECT COUNT(*) AS n FROM orchestration_v2_projection_threads').get().n
        };
        db.exec("COMMIT");db.close();parentPort.postMessage({result});
      } catch(error){parentPort.postMessage({error:String(error)});}
    `,
      { eval: true, workerData: { database, checkpoint } },
    );
    let finished = false;
    const complete = async (error: Error | undefined, result?: CopySnapshot) => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      await worker.terminate();
      if (error !== undefined) reject(error);
      else if (result !== undefined) resolve(result);
    };
    const timer = setTimeout(() => {
      void complete(new Error("Safety copy inspection exceeded 10 seconds"));
    }, 10000);
    const abort = () => {
      void complete(new Error("Safety copy interrupted"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (message) => {
      void complete(message.error ? new Error(message.error) : undefined, message.result);
    });
    worker.once("error", (error) => {
      void complete(error);
    });
    worker.once("exit", (code) => {
      void complete(new Error(`Safety copy worker exited before completion: ${code}`));
    });
  });

const databasePath = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const databases = yield* sql<{
    readonly name: string;
    readonly file: string;
  }>`PRAGMA database_list`;
  return databases.find((row) => row.name === "main")?.file ?? "";
});
const generation = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly updated_at: string;
  }>`SELECT updated_at FROM orchestration_v2_projection_metadata WHERE projection_name = ${GENERATION}`.pipe(
    NodeSqliteClient.readOnly,
  );
  return rows[0]?.updated_at;
});
const deletionRecorded = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    yield* sql`SELECT 1 FROM orchestration_v2_projection_metadata WHERE projection_name = 'event-log-pruned-through'`.pipe(
      NodeSqliteClient.readOnly,
    );
  return rows.length > 0;
});
const restoredWarning = Effect.logWarning(
  "Restored database detected: history pruning is paused and the recovery copy will not expire. After verifying the restored history, remove backups/pre-event-prune/ and restart to resume pruning.",
);
const attempt = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new SafetyCopyError({ cause }) });
const warn = (cause: unknown) =>
  Effect.logWarning(
    "Pre-pruning safety copy failed; history pruning is disabled until the next successful startup",
    { cause },
  );

export const prepare = Effect.fn("PreEventPruneSafety.prepare")(function* () {
  if (!(yield* eventPruningEnabled)) return;
  if ((yield* resolveServiceLauncherMode()).isUpdateTrial) return;
  const options = yield* Preparation;
  const report = yield* Progress;
  const database = yield* databasePath;
  if (database === "") return;
  const sql = yield* SqlClient.SqlClient;
  let id = yield* generation;
  if (id === undefined) {
    id = NodeCrypto.randomUUID();
    yield* sql`INSERT INTO orchestration_v2_projection_metadata (projection_name,schema_version,last_sequence,updated_at) VALUES (${GENERATION},1,0,${id})`;
  }
  const existing = yield* attempt(() => readManifest(database));
  const deleted = yield* deletionRecorded;
  if (existing === undefined && deleted && (yield* attempt(() => copyExists(database)))) {
    return yield* new SafetyCopyError({
      cause:
        "Recovery manifest missing after deletion; preserving the existing copy and disabling pruning",
    });
  }
  if (existing?.generation === id) {
    if (
      existing.firstDeleteStartedAt !== undefined ||
      existing.firstDeleteCompletedAt !== undefined
    ) {
      if (!deleted) yield* restoredWarning;
      return;
    }
    if (yield* attempt(() => copyExists(database))) return;
  }
  if (
    existing !== undefined &&
    (existing.firstDeleteStartedAt !== undefined ||
      existing.firstDeleteCompletedAt !== undefined ||
      deleted)
  )
    return yield* new SafetyCopyError({
      cause:
        "An existing recovery copy belongs to a different database with recorded deletion; preserving it and disabling pruning",
    });
  const target = paths(database);
  const staging = `${target.copy}.staging`;
  let sourceSize = (yield* attempt(() => NodeFSP.stat(database))).size;
  yield* attempt(() => NodeFSP.mkdir(target.directory, { recursive: true, mode: 0o700 }));
  const finish = Effect.fn("PreEventPruneSafety.finish")(function* (
    method: "clone" | "copy",
    before: CopySnapshot,
  ) {
    const [size, wal] = yield* attempt(() =>
      Promise.all([
        NodeFSP.stat(staging),
        NodeFSP.stat(`${database}-wal`).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        }),
      ]),
    );
    if (size.size !== sourceSize || (wal?.size ?? 0) !== 0) {
      return yield* new SafetyCopyError({
        cause: "Source WAL changed or staging size differs from source",
      });
    }
    const [after, copy] = yield* attempt((signal) =>
      Promise.all([inspect(database, false, signal), inspect(staging, false, signal)]),
    );
    if (!copyIsConsistent(before, copy, after)) {
      return yield* new SafetyCopyError({
        cause: "Safety copy is inconsistent with the source snapshots",
      });
    }
    if (
      existing !== undefined &&
      (existing.firstDeleteStartedAt !== undefined ||
        existing.firstDeleteCompletedAt !== undefined ||
        (yield* deletionRecorded))
    ) {
      return yield* new SafetyCopyError({
        cause:
          "Deletion was recorded during copy replacement; preserving the existing recovery copy",
      });
    }
    const createdAt = yield* Clock.currentTimeMillis;
    yield* attempt(async (signal) => {
      if (method === "clone") await sync(staging);
      signal.throwIfAborted();
      const previous = `${target.copy}.previous`;
      const previousManifest = `${target.manifest}.previous`;
      const replacing = existing !== undefined && (await copyExists(database));
      if (replacing) {
        await NodeFSP.copyFile(target.manifest, previousManifest);
        await sync(previousManifest);
        await NodeFSP.rename(target.copy, previous);
      }
      try {
        signal.throwIfAborted();
        await NodeFSP.rename(staging, target.copy);
        await syncDirectory(target.directory);
        await writeManifest(
          database,
          { generation: id, createdAt, method, sourceSize, ...copy },
          signal,
        );
      } catch (cause) {
        if (replacing) {
          await NodeFSP.rename(previous, target.copy);
          await NodeFSP.rename(previousManifest, target.manifest);
          await syncDirectory(target.directory);
        }
        throw cause;
      }
      if (replacing) {
        await NodeFSP.rm(previous, { force: true });
        await NodeFSP.rm(previousManifest, { force: true });
      }
    });
  });
  const cleanup = attempt(async () => {
    await Promise.all(
      ["", "-journal", "-wal", "-shm"].map((suffix) =>
        NodeFSP.rm(`${staging}${suffix}`, { force: true }),
      ),
    );
    await NodeFSP.rm(`${target.manifest}.staging`, { force: true });
  }).pipe(Effect.ignore);
  yield* cleanup;
  const attemptRecord = NodePath.join(target.directory, "last-attempt.json");
  const lastAttempt = yield* attempt(async () => {
    try {
      const value: unknown = JSON.parse(await NodeFSP.readFile(attemptRecord, "utf8"));
      return typeof value === "object" &&
        value !== null &&
        "gaveUpAt" in value &&
        typeof value.gaveUpAt === "number"
        ? value.gaveUpAt
        : undefined;
    } catch {
      return undefined;
    }
  });
  const now = yield* Clock.currentTimeMillis;
  if (lastAttempt !== undefined && now - lastAttempt < RETENTION_MS) {
    yield* Effect.logWarning(
      "Safety copy previously gave up; history pruning remains disabled. Retrying at a startup at least seven days after that attempt.",
    );
    return;
  }
  const checkpoint = yield* attempt((signal) => inspect(database, true, signal));
  sourceSize = (yield* attempt(() => NodeFSP.stat(database))).size;
  const cloned = yield* Effect.gen(function* () {
    if (
      !(yield* attempt((signal) => (options.clone ?? cloneDatabaseFile)(database, staging, signal)))
    )
      return false;
    yield* finish("clone", checkpoint);
    return true;
  }).pipe(Effect.ensuring(cleanup));
  if (cloned) return;
  const freeBytes = yield* attempt(() =>
    options.freeBytes !== undefined
      ? options.freeBytes(target.directory)
      : NodeFSP.statfs(target.directory).then((free) => free.bavail * free.bsize),
  );
  if (freeBytes < sourceSize + databaseCopyHeadroom(sourceSize)) {
    return yield* new SafetyCopyError({
      cause:
        "Not enough free space for the pre-pruning safety copy; startup continues without pruning",
    });
  }
  yield* Effect.logInfo(STARTUP_COPY_MESSAGE, { totalBytes: sourceSize });
  let lastLogAt = now;
  const copy = withCopyBudget(
    sourceSize,
    (progress) =>
      Effect.gen(function* () {
        yield* (options.stream ?? streamDatabaseFile)(database, staging, progress);
        yield* finish("copy", checkpoint);
      }),
    (progress) =>
      Effect.gen(function* () {
        yield* report(progress);
        const time = yield* Clock.currentTimeMillis;
        if (time - lastLogAt >= 10_000) {
          lastLogAt = time;
          yield* Effect.logInfo("Safety copy progress", {
            percent: Math.floor((progress.copiedBytes / sourceSize) * 100),
            copiedBytes: progress.copiedBytes,
            totalBytes: sourceSize,
          });
        }
      }),
  ).pipe(Effect.scoped);
  yield* copy.pipe(
    Effect.tap(() => Effect.logInfo("Safety copy verified and saved", { totalBytes: sourceSize })),
    Effect.catchTags({
      StartupCopyLimit: Effect.fn("PreEventPruneSafety.recordGiveUp")(function* (
        limit: StartupCopyLimit,
      ) {
        const gaveUpAt = yield* Clock.currentTimeMillis;
        yield* attempt(async () => {
          const stagingRecord = `${attemptRecord}.staging`;
          await NodeFSP.writeFile(
            stagingRecord,
            JSON.stringify({ gaveUpAt, reason: limit.reason }),
            { mode: 0o600 },
          );
          await sync(stagingRecord);
          await NodeFSP.rename(stagingRecord, attemptRecord);
          await syncDirectory(target.directory);
        });
        yield* warn(limit);
      }),
    }),
    Effect.onInterrupt(() =>
      Effect.logInfo("Safety copy interrupted; the next startup will retry immediately"),
    ),
    Effect.ensuring(cleanup),
    Effect.ensuring(report(null)),
  );
}, Effect.catch(warn));

export const canPrune = Effect.fn("PreEventPruneSafety.canPrune")(
  function* () {
    if (!(yield* eventPruningEnabled)) return false;
    if ((yield* resolveServiceLauncherMode()).isUpdateTrial) return false;
    const database = yield* databasePath;
    if (database === "") return true;
    const manifest = yield* attempt(() => readManifest(database));
    if (manifest === undefined || manifest.generation !== (yield* generation)) return false;
    if (
      (manifest.firstDeleteStartedAt !== undefined ||
        manifest.firstDeleteCompletedAt !== undefined) &&
      !(yield* deletionRecorded)
    ) {
      yield* restoredWarning;
      return false;
    }
    const now = yield* Clock.currentTimeMillis;
    if (
      manifest.firstDeleteCompletedAt !== undefined &&
      now - manifest.firstDeleteCompletedAt >= RETENTION_MS
    ) {
      yield* attempt(() => NodeFSP.rm(paths(database).copy, { force: true }));
      return true;
    }
    return yield* attempt(() => copyExists(database));
  },
  Effect.catch((cause) => warn(cause).pipe(Effect.as(false))),
);

export const deletePassFinished = Effect.fn("PreEventPruneSafety.deletePassFinished")(function* () {
  const database = yield* databasePath;
  if (database === "") return;
  const manifest = yield* attempt(() => readManifest(database));
  if (manifest === undefined || manifest.firstDeleteCompletedAt !== undefined) return;
  const firstDeleteCompletedAt = yield* Clock.currentTimeMillis;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_metadata (projection_name,schema_version,last_sequence,updated_at) VALUES ('event-log-pruned-through',1,0,${DateTime.formatIso(DateTime.makeUnsafe(firstDeleteCompletedAt))}) ON CONFLICT(projection_name) DO NOTHING`;
  yield* attempt(() => writeManifest(database, { ...manifest, firstDeleteCompletedAt }));
}, Effect.catch(warn));

export const deletePassStarted = Effect.fn("PreEventPruneSafety.deletePassStarted")(function* () {
  const database = yield* databasePath;
  if (database === "") return;
  const manifest = yield* attempt(() => readManifest(database));
  if (manifest === undefined)
    return yield* new SafetyCopyError({ cause: "Recovery manifest disappeared before deletion" });
  if (manifest.firstDeleteStartedAt !== undefined) return;
  const firstDeleteStartedAt = yield* Clock.currentTimeMillis;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_metadata (projection_name,schema_version,last_sequence,updated_at) VALUES ('event-log-pruned-through',1,0,${DateTime.formatIso(DateTime.makeUnsafe(firstDeleteStartedAt))}) ON CONFLICT(projection_name) DO NOTHING`;
  yield* attempt(() => writeManifest(database, { ...manifest, firstDeleteStartedAt }));
});
