// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { inspect, type CopySnapshot } from "./startupDatabaseInspection.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { eventPruningEnabled } from "../config.ts";
import { resolveServiceLauncherMode } from "../cloud/serviceLauncherClient.ts";
import { cloneDatabaseFile, databaseCopyHeadroom } from "./databaseFileCopy.ts";
import * as Context from "effect/Context";
import { STARTUP_COPY_MESSAGE, type ServerStartupCopyProgress } from "@t3tools/contracts";
import { streamDatabaseFile, withCopyBudget } from "./startupFileCopy.ts";

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

class SafetyCopyError extends Schema.TaggedError<SafetyCopyError>()("SafetyCopyError", {
  cause: Schema.Defect(),
}) {}

class SafetyCopyVerificationError extends Schema.TaggedError<SafetyCopyVerificationError>()(
  "SafetyCopyVerificationError",
  {
    reason: Schema.Literals(["size-or-wal", "snapshot-mismatch", "unreadable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

class SafetyCopyTimeout extends Schema.TaggedError<SafetyCopyTimeout>()("SafetyCopyTimeout", {
  phase: Schema.Literals(["inspection", "preparation"]),
}) {
  override get message() {
    return this.phase === "inspection"
      ? "Safety copy inspection exceeded the 60-second startup budget; row counting or WAL checkpoint did not finish"
      : "Safety copy checkpoint, clone and verification exceeded 120 seconds; startup continues without pruning";
  }
}

const isSafetyCopyError = Schema.is(SafetyCopyError);
const GENERATION = "pre-event-prune-generation";
const COPY_ID = "pre-event-prune-copy";
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
  copyId?: string;
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
      (record.copyId !== undefined && typeof record.copyId !== "string") ||
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
const matchesCopy = Effect.fn("PreEventPruneSafety.matchesCopy")(function* (manifest: Manifest) {
  if (manifest.copyId === undefined) return false;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly updated_at: string;
  }>`SELECT updated_at FROM orchestration_v2_projection_metadata WHERE projection_name = ${COPY_ID}`.pipe(
    NodeSqliteClient.readOnly,
  );
  return rows[0]?.updated_at === manifest.copyId;
});
const restoredWarning = Effect.logWarning(
  "Restored database detected: history pruning is paused and the recovery copy will not expire. After verifying the restored history, remove backups/pre-event-prune/ and restart to resume pruning.",
);
const legacyRecoveryMessage = (database: string) =>
  `Legacy recovery copy identity cannot be verified in ${paths(database).directory}. Unused copies are adopted at startup; otherwise pruning is paused and the copy will not expire. Verify the thread history, stop styal, move backups/pre-event-prune/ somewhere safe, and restart to make a new verified copy.`;

export const legacyRecoveryNotice = Effect.fn("PreEventPruneSafety.legacyRecoveryNotice")(
  function* (database: string) {
    const manifest = yield* attempt(() => readManifest(database));
    return manifest !== undefined && manifest.copyId === undefined
      ? legacyRecoveryMessage(database)
      : undefined;
  },
);
const retryCopyWarning = Effect.logWarning(
  "Unpublished recovery copy is missing; making a new safety copy before pruning.",
);
const missingCopyWarning = Effect.logWarning(
  "Recovery copy is missing; history pruning is disabled. Restore the copy or remove backups/pre-event-prune/ and restart to make a new one.",
);
const attempt = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new SafetyCopyError({ cause }) });
export const cleanupInterruptedCopy = Effect.fn("PreEventPruneSafety.cleanupInterruptedCopy")(
  function* (database: string) {
    if (database === "") return;
    const target = paths(database);
    yield* attempt(async () => {
      await Promise.all(
        ["", "-journal", "-wal", "-shm"].map((suffix) =>
          NodeFSP.rm(`${target.copy}.staging${suffix}`, { force: true }),
        ),
      );
      await NodeFSP.rm(`${target.manifest}.staging`, { force: true });
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning(
          "Could not remove an interrupted safety-copy staging file; cleanup will retry at the next startup.",
          { cause },
        ),
      ),
    );
  },
);

const warn = (cause: unknown) =>
  Effect.logWarning(
    "Pre-pruning safety copy failed; history pruning is disabled until the next successful startup",
    { cause: isSafetyCopyError(cause) ? String(cause.cause) : cause },
  );

const writeDurably = Effect.fn("PreEventPruneSafety.writeDurably")(function* (
  query: string,
  params: ReadonlyArray<unknown>,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* Effect.gen(function* () {
    const connection = yield* sql.reserve;
    const synchronous = (yield* connection.executeValues("PRAGMA synchronous", []))[0]?.[0];
    const fullfsync = (yield* connection.executeValues("PRAGMA fullfsync", []))[0]?.[0];
    if (typeof synchronous !== "number" || typeof fullfsync !== "number")
      return yield* new SafetyCopyError({ cause: "Could not read database durability settings" });
    yield* Effect.acquireUseRelease(
      Effect.void,
      () =>
        connection
          .execute("PRAGMA synchronous = FULL", [], undefined)
          .pipe(
            Effect.andThen(connection.execute("PRAGMA fullfsync = ON", [], undefined)),
            Effect.andThen(connection.execute(query, params, undefined)),
          ),
      () =>
        connection
          .execute(`PRAGMA synchronous = ${Number(synchronous)}`, [], undefined)
          .pipe(
            Effect.andThen(
              connection.execute(`PRAGMA fullfsync = ${Number(fullfsync)}`, [], undefined),
            ),
            Effect.orDie,
          ),
    );
  }).pipe(Effect.scoped);
});

const createCopyIdentity = Effect.fn("PreEventPruneSafety.createCopyIdentity")(function* () {
  const copyId = NodeCrypto.randomUUID();
  yield* writeDurably(
    "INSERT INTO orchestration_v2_projection_metadata (projection_name,schema_version,last_sequence,updated_at) VALUES ('pre-event-prune-copy',1,0,?) ON CONFLICT(projection_name) DO UPDATE SET updated_at = excluded.updated_at",
    [copyId],
  );
  return copyId;
});

export const prepare = Effect.fn("PreEventPruneSafety.prepare")(function* () {
  const database = yield* databasePath;
  if (database === "") return;
  const cleanup = cleanupInterruptedCopy(database);
  yield* cleanup;
  if (!(yield* eventPruningEnabled)) return;
  if ((yield* resolveServiceLauncherMode()).isUpdateTrial) return;
  const options = yield* Preparation;
  const report = yield* Progress;
  const cleanupPrevious = attempt(async () => {
    await NodeFSP.rm(`${paths(database).copy}.previous`, { force: true });
    await NodeFSP.rm(`${paths(database).manifest}.previous`, { force: true });
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning(
        "Safety copy is ready, but an unused previous copy could not be removed; the next startup will retry cleanup.",
        { cause },
      ),
    ),
  );
  const inspectWithinBudget = Effect.fn("PreEventPruneSafety.inspect")(function* <A>(
    work: (signal: AbortSignal) => Promise<A>,
    verification = false,
  ) {
    const signal = yield* Effect.abortSignal;
    return yield* attempt(() => work(signal)).pipe(
      Effect.mapError((error) =>
        verification
          ? new SafetyCopyVerificationError({ reason: "unreadable", cause: error })
          : error,
      ),
      Effect.timeoutOrElse({
        duration: 60_000,
        orElse: () => Effect.fail(new SafetyCopyTimeout({ phase: "inspection" })),
      }),
    );
  }, Effect.scoped);
  const sql = yield* SqlClient.SqlClient;
  let id = yield* generation;
  if (id === undefined) {
    id = NodeCrypto.randomUUID();
    yield* sql`INSERT INTO orchestration_v2_projection_metadata (projection_name,schema_version,last_sequence,updated_at) VALUES (${GENERATION},1,0,${id})`;
  }
  let existing = yield* attempt(() => readManifest(database));
  const deleted = yield* deletionRecorded;
  if (existing === undefined && deleted && (yield* attempt(() => copyExists(database)))) {
    return yield* new SafetyCopyError({
      cause:
        "Recovery manifest missing after deletion; preserving the existing copy and disabling pruning",
    });
  }
  if (
    existing?.generation === id &&
    existing.copyId === undefined &&
    !deleted &&
    existing.firstDeleteStartedAt === undefined &&
    existing.firstDeleteCompletedAt === undefined
  ) {
    if (yield* attempt(() => copyExists(database))) {
      const copyId = yield* createCopyIdentity();
      const adopted = { ...existing, copyId };
      yield* attempt((signal) => writeManifest(database, adopted, signal));
      existing = adopted;
    } else {
      yield* retryCopyWarning;
      yield* attempt(() => NodeFSP.rm(paths(database).manifest));
      existing = undefined;
    }
  }
  if (existing?.generation === id) {
    if (!(yield* matchesCopy(existing))) {
      yield* existing.copyId === undefined
        ? Effect.logWarning(legacyRecoveryMessage(database))
        : restoredWarning;
      return;
    }
    if (
      (yield* attempt(() => copyExists(database))) ||
      (deleted &&
        existing.firstDeleteCompletedAt !== undefined &&
        (yield* Clock.currentTimeMillis) - existing.firstDeleteCompletedAt >= RETENTION_MS)
    )
      yield* cleanupPrevious;
    // A manifest published before the copy rename cannot have authorized any deletion.
    if (
      existing.firstDeleteStartedAt === undefined &&
      existing.firstDeleteCompletedAt === undefined &&
      !(yield* attempt(() => copyExists(database)))
    ) {
      yield* retryCopyWarning;
      yield* attempt(() => NodeFSP.rm(paths(database).manifest));
      existing = undefined;
    }
  }
  if (existing?.generation === id) {
    if (
      existing.firstDeleteStartedAt !== undefined ||
      existing.firstDeleteCompletedAt !== undefined
    ) {
      if (!deleted) yield* restoredWarning;
      else if (
        !(yield* attempt(() => copyExists(database))) &&
        (existing.firstDeleteCompletedAt === undefined ||
          (yield* Clock.currentTimeMillis) - existing.firstDeleteCompletedAt < RETENTION_MS)
      )
        yield* missingCopyWarning;
      return;
    }
    return;
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
  const verify = Effect.fn("PreEventPruneSafety.verify")(function* (before: CopySnapshot) {
    yield* report({
      phase: "copying",
      copiedBytes: sourceSize,
      totalBytes: sourceSize,
      leaseMs: 60_000,
    });
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
      return yield* new SafetyCopyVerificationError({ reason: "size-or-wal" });
    }
    const [after, copy] = yield* Effect.all(
      [
        inspectWithinBudget((signal) => inspect(database, false, signal), true),
        inspectWithinBudget((signal) => inspect(staging, false, signal), true),
      ],
      { concurrency: "unbounded" },
    );
    if (!copyIsConsistent(before, copy, after)) {
      return yield* new SafetyCopyVerificationError({ reason: "snapshot-mismatch" });
    }
    return copy;
  });
  const publish = Effect.fn("PreEventPruneSafety.publish")(function* (
    method: "clone" | "copy",
    copy: CopySnapshot,
  ) {
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
    const copyId = yield* createCopyIdentity();
    yield* attempt(async (signal) => {
      await NodeFSP.chmod(staging, 0o600);
      if (method === "clone") await sync(staging);
      signal.throwIfAborted();
      const previous = `${target.copy}.previous`;
      const previousManifest = `${target.manifest}.previous`;
      const replacing = await copyExists(database);
      if (replacing) {
        if (existing !== undefined) {
          await NodeFSP.copyFile(target.manifest, previousManifest);
          await sync(previousManifest);
        }
        await NodeFSP.rename(target.copy, previous);
      }
      try {
        signal.throwIfAborted();
        await writeManifest(
          database,
          { copyId, generation: id, createdAt, method, sourceSize, ...copy },
          signal,
        );
        signal.throwIfAborted();
        await NodeFSP.rename(staging, target.copy);
        await syncDirectory(target.directory);
      } catch (cause) {
        if (replacing) {
          // Remove the new identity before restoring either half of the previous pair.
          await NodeFSP.rm(target.manifest, { force: true });
          if (existing !== undefined) await NodeFSP.rename(previousManifest, target.manifest);
          await NodeFSP.rename(previous, target.copy);
          await syncDirectory(target.directory);
        }
        throw cause;
      }
    });
    yield* cleanupPrevious;
  });
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
  const recordGiveUp = Effect.fn("PreEventPruneSafety.recordGiveUp")(function* (reason: string) {
    const gaveUpAt = yield* Clock.currentTimeMillis;
    yield* attempt(async () => {
      const stagingRecord = `${attemptRecord}.staging`;
      await NodeFSP.writeFile(stagingRecord, JSON.stringify({ gaveUpAt, reason }), {
        mode: 0o600,
      });
      await sync(stagingRecord);
      await NodeFSP.rename(stagingRecord, attemptRecord);
      await syncDirectory(target.directory);
    });
    yield* Effect.logWarning("Safety copy gave up; history pruning is disabled for seven days.", {
      reason,
    });
  });
  return yield* Effect.gen(function* () {
    yield* Effect.addFinalizer(() => report(null));
    yield* report({ phase: "copying", copiedBytes: 0, totalBytes: sourceSize, leaseMs: 60_000 });
    const startedAt = yield* Clock.currentTimeMillis;
    const checkpoint = yield* inspectWithinBudget((signal) => inspect(database, true, signal));
    sourceSize = (yield* attempt(() => NodeFSP.stat(database))).size;
    yield* report({ phase: "copying", copiedBytes: 0, totalBytes: sourceSize, leaseMs: 60_000 });
    const cloned = yield* Effect.gen(function* () {
      if (
        !(yield* attempt((signal) =>
          (options.clone ?? cloneDatabaseFile)(database, staging, signal),
        ))
      )
        return false;
      return yield* verify(checkpoint);
    }).pipe(
      // Each inspection gets 60 s; cap checkpoint + clone + verification at 120 s, leaving desktop headroom.
      Effect.timeoutOrElse({
        duration: Math.max(0, 120_000 - ((yield* Clock.currentTimeMillis) - startedAt)),
        orElse: () => Effect.fail(new SafetyCopyTimeout({ phase: "preparation" })),
      }),
      Effect.onError(() => cleanup),
    );
    if (cloned !== false) return yield* publish("clone", cloned).pipe(Effect.ensuring(cleanup));
    yield* cleanup;
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
      (progress) => (options.stream ?? streamDatabaseFile)(database, staging, progress),
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
      Effect.andThen(verify(checkpoint)),
      Effect.flatMap((snapshot) => publish("copy", snapshot)),
      Effect.tap(() =>
        Effect.logInfo("Safety copy verified and saved", { totalBytes: sourceSize }),
      ),
      Effect.catchTags({
        StartupCopyLimit: (limit) => recordGiveUp(limit.reason),
        SafetyCopyVerificationError: (failure) =>
          Effect.logWarning("Safety copy verification failed", {
            reason: failure.reason,
            cause: failure.cause,
          }).pipe(Effect.andThen(recordGiveUp(failure.reason))),
      }),
      Effect.onInterrupt(() =>
        Effect.logInfo("Safety copy interrupted; the next startup will retry immediately"),
      ),
      Effect.ensuring(cleanup),
    );
  }).pipe(
    Effect.catchTags({
      SafetyCopyTimeout: (failure) =>
        Effect.logWarning(failure.message).pipe(
          Effect.andThen(recordGiveUp(`${failure.phase}-timeout`)),
        ),
    }),
    Effect.scoped,
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
    if (!(yield* matchesCopy(manifest))) {
      yield* manifest.copyId === undefined
        ? Effect.logWarning(legacyRecoveryMessage(database))
        : restoredWarning;
      return false;
    }
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
    const exists = yield* attempt(() => copyExists(database));
    if (!exists) {
      const retryable =
        manifest.firstDeleteStartedAt === undefined &&
        manifest.firstDeleteCompletedAt === undefined;
      yield* retryable
        ? Effect.logWarning(
            "Recovery copy is missing; history pruning is disabled until the next startup retries the safety copy.",
          )
        : missingCopyWarning;
    }
    return exists;
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
  // SQLite skips the WAL commit if the boundary's timestamp is unchanged.
  yield* writeDurably(
    "INSERT INTO orchestration_v2_projection_metadata (projection_name,schema_version,last_sequence,updated_at) VALUES ('event-log-pruned-through',1,0,?) ON CONFLICT(projection_name) DO UPDATE SET updated_at = CASE WHEN updated_at = excluded.updated_at THEN strftime('%Y-%m-%dT%H:%M:%fZ', excluded.updated_at, '+0.001 seconds') ELSE excluded.updated_at END",
    [DateTime.formatIso(DateTime.makeUnsafe(firstDeleteStartedAt))],
  );
  yield* attempt(() => writeManifest(database, { ...manifest, firstDeleteStartedAt }));
});
