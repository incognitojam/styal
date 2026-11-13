import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as NetService from "@t3tools/shared/Net";
import { withT3CodeProjectEnvironmentAliases } from "@t3tools/shared/projectScripts";

export const WORKSPACE_PORT_ENV_VAR = "STYAL_WORKSPACE_PORT";
export const WORKSPACE_PORT_RANGE_SIZE = 10;
export const WORKSPACE_PORT_MIN = 20_000;
export const WORKSPACE_PORT_MAX = 29_990;

const WORKSPACE_PORT_RANGE_COUNT =
  (WORKSPACE_PORT_MAX - WORKSPACE_PORT_MIN) / WORKSPACE_PORT_RANGE_SIZE + 1;
/** Blocks freed beyond the one needed, so the next few new workspaces skip another reclaim pass. */
const RECLAIM_MARGIN = 7;
/** A range handed out recently may belong to a thread the projections do not show as open yet. */
const HANDED_OUT_GRACE_MS = 10 * 60 * 1_000;
/** After a reclaim pass frees nothing, later allocations skip the pass for this long. */
const FRUITLESS_RECLAIM_BACKOFF_MS = 60 * 1_000;

interface WorkspacePortRow {
  readonly basePort: number;
}

class WorkspacePortRangesExhaustedError extends Schema.TaggedError<WorkspacePortRangesExhaustedError>()(
  "WorkspacePortRangesExhaustedError",
  {},
) {}

export class WorkspacePortReleaseError extends Schema.TaggedError<WorkspacePortReleaseError>()(
  "WorkspacePortReleaseError",
  {
    workspacePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to release the development port range for workspace '${this.workspacePath}'.`;
  }
}

export class WorkspacePortHoldersError extends Schema.TaggedError<WorkspacePortHoldersError>()(
  "WorkspacePortHoldersError",
  { cause: Schema.Defect() },
) {}

export interface WorkspacePortHolderSnapshot {
  /** Resolved workspace paths with an open thread. */
  readonly openPaths: ReadonlySet<string>;
  /** Latest thread activity per resolved workspace path, closed threads included. */
  readonly lastActivityMs: ReadonlyMap<string, number>;
}

/** Which workspaces still need their ports; the allocator reclaims the rest only when the pool is full. */
export class WorkspacePortHolders extends Context.Service<
  WorkspacePortHolders,
  {
    readonly snapshot: Effect.Effect<WorkspacePortHolderSnapshot, WorkspacePortHoldersError>;
  }
>()("@styal/cli/workspace/WorkspacePortAllocator/WorkspacePortHolders") {}

export class WorkspacePortAllocator extends Context.Service<
  WorkspacePortAllocator,
  {
    /** The workspace's first port, or null when no range is free; callers carry on without one. */
    readonly getBasePort: (workspacePath: string) => Effect.Effect<number | null>;
    /** The port variables for the workspace, empty when no range is free. */
    readonly environmentFor: (workspacePath: string) => Effect.Effect<Record<string, string>>;
    /** Frees the workspace's range after its directory is deleted for good. */
    readonly release: (workspacePath: string) => Effect.Effect<void, WorkspacePortReleaseError>;
    /** A live terminal started with the workspace's ports keeps its range until it ends. */
    readonly holdForTerminal: (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly workspacePath: string;
    }) => Effect.Effect<void>;
    readonly releaseTerminalHold: (input: {
      readonly threadId: string;
      readonly terminalId: string;
    }) => Effect.Effect<void>;
  }
>()("@styal/cli/workspace/WorkspacePortAllocator") {}

function hashWorkspacePath(workspacePath: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < workspacePath.length; index += 1) {
    hash = Math.imul(hash ^ workspacePath.charCodeAt(index), 16_777_619);
  }
  return hash >>> 0;
}

function preferredBasePort(workspacePath: string): number {
  return (
    WORKSPACE_PORT_MIN +
    (hashWorkspacePath(workspacePath) % WORKSPACE_PORT_RANGE_COUNT) * WORKSPACE_PORT_RANGE_SIZE
  );
}

interface PoolCensus {
  readonly openThread: number;
  readonly closedThread: number;
  readonly noThread: number;
  readonly missingPath: number;
  readonly uncheckedPath: number;
  readonly inUseByListener: number;
  readonly existingPath: number;
  readonly recentlyHandedOut: number;
  readonly heldByTerminal: number;
}

export const make = Effect.fn("WorkspacePortAllocator.make")(function* (options?: {
  readonly hasListener?: (port: number) => Effect.Effect<boolean>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const holders = yield* Effect.serviceOption(WorkspacePortHolders);
  const allocationLock = yield* Semaphore.make(1);
  const net = NetService.make();
  const hasListener =
    options?.hasListener ??
    ((port: number) =>
      Effect.zipWith(
        net.hasListenerOnHost(port, "127.0.0.1"),
        net.hasListenerOnHost(port, "::1"),
        (ipv4, ipv6) => ipv4 || ipv6,
      ));
  // Probes run per candidate block, inside allocation spans that already trace them.
  const blockHasListener = Effect.fnUntraced(function* (basePort: number) {
    for (let offset = 0; offset < WORKSPACE_PORT_RANGE_SIZE; offset += 1) {
      if (yield* hasListener(basePort + offset)) return true;
    }
    return false;
  });
  const handedOutAtMs = new Map<string, number>();
  const terminalHolds = new Map<string, string>();
  const terminalKey = (input: { readonly threadId: string; readonly terminalId: string }) =>
    `${input.threadId}\0${input.terminalId}`;
  // One warning per exhausted episode, so a full pool does not log once per thread.
  let exhaustionReported = false;
  // Local threads get no notice row, so every workspace left without ports is named once in the log.
  const workspacesWithoutPorts = new Set<string>();
  let fruitlessReclaimAtMs: number | null = null;

  const noteHandedOut = Effect.fnUntraced(function* (normalizedPath: string) {
    const nowMs = yield* Clock.currentTimeMillis;
    for (const [workspacePath, at] of handedOutAtMs) {
      if (nowMs - at >= HANDED_OUT_GRACE_MS) handedOutAtMs.delete(workspacePath);
    }
    handedOutAtMs.set(normalizedPath, nowMs);
  });

  const findExisting = (normalizedPath: string) =>
    sql<WorkspacePortRow>`
      SELECT base_port AS "basePort"
      FROM workspace_port_allocations
      WHERE workspace_path = ${normalizedPath}
    `.pipe(Effect.map((rows) => rows[0]?.basePort));

  const deleteReservations = (workspacePaths: ReadonlyArray<string>) =>
    workspacePaths.length === 0
      ? Effect.void
      : sql`
          DELETE FROM workspace_port_allocations
          WHERE ${sql.in("workspace_path", workspacePaths)}
        `.pipe(Effect.asVoid);

  // Reservations are only a cache: deleted folders lose theirs first, then the
  // least recently active workspaces without an open thread or live terminal,
  // never ones a listener still uses. Paths the filesystem cannot confirm keep their ports.
  const reclaim = Effect.fn("WorkspacePortAllocator.reclaim")(function* () {
    const allocations = yield* sql<{ readonly workspacePath: string; readonly basePort: number }>`
      SELECT workspace_path AS "workspacePath", base_port AS "basePort"
      FROM workspace_port_allocations
    `;
    const checked = yield* Effect.forEach(
      allocations,
      (allocation) =>
        fs.stat(allocation.workspacePath).pipe(
          Effect.match({
            onSuccess: () => ({ ...allocation, state: "exists" as const }),
            onFailure: (error) => ({
              ...allocation,
              state: error.reason._tag === "NotFound" ? ("missing" as const) : ("unknown" as const),
            }),
          }),
        ),
      { concurrency: 16 },
    );
    const missing = checked.filter((entry) => entry.state === "missing");
    yield* deleteReservations(missing.map((entry) => entry.workspacePath));

    const nowMs = yield* Clock.currentTimeMillis;
    const terminalPaths = new Set(terminalHolds.values());
    const recentlyHandedOut = (workspacePath: string) => {
      const at = handedOutAtMs.get(workspacePath);
      return at !== undefined && nowMs - at < HANDED_OUT_GRACE_MS;
    };
    const existing = checked.filter((entry) => entry.state === "exists");
    const snapshot = Option.isNone(holders)
      ? null
      : yield* holders.value.snapshot.pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("could not read which workspaces still need their ports", { cause }),
          ),
          Effect.orElseSucceed(() => null),
        );
    const openThread = existing.filter((entry) => snapshot?.openPaths.has(entry.workspacePath));
    const closed =
      snapshot === null
        ? []
        : existing
            .filter(
              (entry) =>
                !snapshot.openPaths.has(entry.workspacePath) &&
                !terminalPaths.has(entry.workspacePath) &&
                !recentlyHandedOut(entry.workspacePath),
            )
            .map((entry) => ({
              ...entry,
              lastActivityMs:
                snapshot.lastActivityMs.get(entry.workspacePath) ?? Number.NEGATIVE_INFINITY,
            }))
            .toSorted((left, right) => left.lastActivityMs - right.lastActivityMs);

    const wanted = Math.max(0, 1 + RECLAIM_MARGIN - missing.length);
    const reclaimed: string[] = [];
    let inUseByListener = 0;
    for (const entry of closed) {
      if (reclaimed.length >= wanted) break;
      if (yield* blockHasListener(entry.basePort)) {
        inUseByListener += 1;
        continue;
      }
      reclaimed.push(entry.workspacePath);
    }
    // A lookup may have handed one of these out since the snapshot; it marks the path first.
    const stillUnused = reclaimed.filter((workspacePath) => !recentlyHandedOut(workspacePath));
    yield* deleteReservations(stillUnused);
    fruitlessReclaimAtMs = missing.length + stillUnused.length > 0 ? null : nowMs;
    if (missing.length + stillUnused.length > 0) {
      yield* Effect.logInfo("reclaimed workspace port ranges", {
        missingPaths: missing.length,
        closedWorkspaces: stillUnused.length,
      });
    }

    return {
      openThread: openThread.length,
      closedThread: closed.filter((entry) => Number.isFinite(entry.lastActivityMs)).length,
      noThread: closed.filter((entry) => !Number.isFinite(entry.lastActivityMs)).length,
      missingPath: missing.length,
      uncheckedPath: checked.filter((entry) => entry.state === "unknown").length,
      inUseByListener,
      existingPath: existing.length,
      recentlyHandedOut: existing.filter((entry) => recentlyHandedOut(entry.workspacePath)).length,
      heldByTerminal: terminalPaths.size,
    } satisfies PoolCensus;
  });

  const allocate = Effect.fn("WorkspacePortAllocator.allocate")(function* (normalizedPath: string) {
    const existingPort = yield* findExisting(normalizedPath);
    if (existingPort !== undefined) return existingPort;

    const taken = new Set(
      (yield* sql<WorkspacePortRow>`
        SELECT base_port AS "basePort" FROM workspace_port_allocations
      `).map((row) => row.basePort),
    );
    const preferred = preferredBasePort(normalizedPath);
    for (let offset = 0; offset < WORKSPACE_PORT_RANGE_COUNT; offset += 1) {
      const candidate =
        WORKSPACE_PORT_MIN +
        (((preferred - WORKSPACE_PORT_MIN) / WORKSPACE_PORT_RANGE_SIZE + offset) %
          WORKSPACE_PORT_RANGE_COUNT) *
          WORKSPACE_PORT_RANGE_SIZE;
      if (taken.has(candidate)) continue;
      // A process can outlive the reservation it was started with.
      if (yield* blockHasListener(candidate)) continue;
      const inserted = yield* sql<WorkspacePortRow>`
        INSERT INTO workspace_port_allocations (workspace_path, base_port)
        VALUES (${normalizedPath}, ${candidate})
        ON CONFLICT DO NOTHING
        RETURNING base_port AS "basePort"
      `;
      const insertedPort = inserted[0]?.basePort;
      if (insertedPort !== undefined) {
        // A new range was free, so the next exhaustion is a new episode worth a warning.
        exhaustionReported = false;
        return insertedPort;
      }
      const concurrentPort = yield* findExisting(normalizedPath);
      if (concurrentPort !== undefined) return concurrentPort;
    }

    return yield* new WorkspacePortRangesExhaustedError();
  });

  const allocateUnderPressure = Effect.fn("WorkspacePortAllocator.allocateUnderPressure")(
    function* (normalizedPath: string) {
      const allocateOrNull = allocate(normalizedPath).pipe(
        Effect.catchTags({ WorkspacePortRangesExhaustedError: () => Effect.succeed(null) }),
      );
      const first = yield* allocateOrNull;
      if (first !== null) return first;
      const nowMs = yield* Clock.currentTimeMillis;
      if (
        fruitlessReclaimAtMs !== null &&
        nowMs - fruitlessReclaimAtMs < FRUITLESS_RECLAIM_BACKOFF_MS
      ) {
        return null;
      }
      const census = yield* reclaim();
      const retried = yield* allocateOrNull;
      if (retried !== null) return retried;
      if (!exhaustionReported) {
        exhaustionReported = true;
        yield* Effect.logWarning(
          "no free workspace port ranges; workspaces start without reserved ports",
          { workspacePath: normalizedPath, ...census },
        );
      }
      return null;
    },
  );

  const getBasePort: WorkspacePortAllocator["Service"]["getBasePort"] = Effect.fn(
    "WorkspacePortAllocator.getBasePort",
  )(
    function* (workspacePath) {
      const normalizedPath = path.resolve(workspacePath);
      // Marked before the read, so a reclaim pass that is about to delete this row skips it.
      yield* noteHandedOut(normalizedPath);
      const existingPort = yield* findExisting(normalizedPath);
      if (existingPort !== undefined) return existingPort;
      const basePort = yield* allocationLock.withPermits(1)(allocateUnderPressure(normalizedPath));
      if (basePort !== null) {
        workspacesWithoutPorts.delete(normalizedPath);
      } else if (!workspacesWithoutPorts.has(normalizedPath)) {
        workspacesWithoutPorts.add(normalizedPath);
        yield* Effect.logInfo("workspace starts without reserved ports", {
          workspacePath: normalizedPath,
        });
      }
      return basePort;
    },
    (effect, workspacePath) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("workspace port allocation failed; continuing without reserved ports", {
            workspacePath,
            cause,
          }).pipe(Effect.as(null)),
        ),
      ),
  );

  const environmentFor: WorkspacePortAllocator["Service"]["environmentFor"] = (workspacePath) =>
    getBasePort(workspacePath).pipe(
      Effect.map((basePort) =>
        basePort === null
          ? {}
          : withT3CodeProjectEnvironmentAliases({
              [WORKSPACE_PORT_ENV_VAR]: String(basePort),
            }),
      ),
    );

  const release: WorkspacePortAllocator["Service"]["release"] = (workspacePath) =>
    allocationLock
      .withPermits(1)(
        deleteReservations([path.resolve(workspacePath)]).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              handedOutAtMs.delete(path.resolve(workspacePath));
              fruitlessReclaimAtMs = null;
            }),
          ),
        ),
      )
      .pipe(Effect.mapError((cause) => new WorkspacePortReleaseError({ workspacePath, cause })));

  const holdForTerminal: WorkspacePortAllocator["Service"]["holdForTerminal"] = (input) =>
    Effect.sync(() => {
      terminalHolds.set(terminalKey(input), path.resolve(input.workspacePath));
    });

  const releaseTerminalHold: WorkspacePortAllocator["Service"]["releaseTerminalHold"] = (input) =>
    Effect.sync(() => {
      terminalHolds.delete(terminalKey(input));
    });

  return WorkspacePortAllocator.of({
    getBasePort,
    environmentFor,
    release,
    holdForTerminal,
    releaseTerminalHold,
  });
});

export const layer = Layer.effect(WorkspacePortAllocator, make());
