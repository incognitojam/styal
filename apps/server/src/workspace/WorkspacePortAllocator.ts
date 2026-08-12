import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const WORKSPACE_PORT_ENV_VAR = "T3CODE_WORKSPACE_PORT";
export const WORKSPACE_PORT_RANGE_SIZE = 10;
export const WORKSPACE_PORT_MIN = 20_000;
export const WORKSPACE_PORT_MAX = 29_990;

const WORKSPACE_PORT_RANGE_COUNT =
  (WORKSPACE_PORT_MAX - WORKSPACE_PORT_MIN) / WORKSPACE_PORT_RANGE_SIZE + 1;

interface WorkspacePortRow {
  readonly basePort: number;
}

class WorkspacePortRangesExhaustedError extends Schema.TaggedErrorClass<WorkspacePortRangesExhaustedError>()(
  "WorkspacePortRangesExhaustedError",
  {},
) {}

export class WorkspacePortAllocationError extends Schema.TaggedErrorClass<WorkspacePortAllocationError>()(
  "WorkspacePortAllocationError",
  {
    workspacePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to allocate a development port range for workspace '${this.workspacePath}'.`;
  }
}

export class WorkspacePortAllocator extends Context.Service<
  WorkspacePortAllocator,
  {
    readonly getBasePort: (
      workspacePath: string,
    ) => Effect.Effect<number, WorkspacePortAllocationError>;
    readonly environmentFor: (
      workspacePath: string,
    ) => Effect.Effect<Record<string, string>, WorkspacePortAllocationError>;
  }
>()("t3/workspace/WorkspacePortAllocator") {}

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

export const make = Effect.fn("WorkspacePortAllocator.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;
  const allocationLock = yield* Semaphore.make(1);

  const allocate = Effect.fn("WorkspacePortAllocator.allocate")(function* (workspacePath: string) {
    const normalizedPath = path.resolve(workspacePath);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* sql<WorkspacePortRow>`
          SELECT base_port AS "basePort"
          FROM workspace_port_allocations
          WHERE workspace_path = ${normalizedPath}
        `;
        const existingPort = existing[0]?.basePort;
        if (existingPort !== undefined) return existingPort;

        const preferred = preferredBasePort(normalizedPath);
        for (let offset = 0; offset < WORKSPACE_PORT_RANGE_COUNT; offset += 1) {
          const candidate =
            WORKSPACE_PORT_MIN +
            (((preferred - WORKSPACE_PORT_MIN) / WORKSPACE_PORT_RANGE_SIZE + offset) %
              WORKSPACE_PORT_RANGE_COUNT) *
              WORKSPACE_PORT_RANGE_SIZE;
          const inserted = yield* sql<WorkspacePortRow>`
            INSERT INTO workspace_port_allocations (workspace_path, base_port)
            VALUES (${normalizedPath}, ${candidate})
            ON CONFLICT DO NOTHING
            RETURNING base_port AS "basePort"
          `;
          const insertedPort = inserted[0]?.basePort;
          if (insertedPort !== undefined) return insertedPort;

          const concurrentlyAllocated = yield* sql<WorkspacePortRow>`
            SELECT base_port AS "basePort"
            FROM workspace_port_allocations
            WHERE workspace_path = ${normalizedPath}
          `;
          const concurrentPort = concurrentlyAllocated[0]?.basePort;
          if (concurrentPort !== undefined) return concurrentPort;
        }

        return yield* new WorkspacePortRangesExhaustedError();
      }),
    );
  });

  const getBasePort: WorkspacePortAllocator["Service"]["getBasePort"] = (workspacePath) =>
    allocationLock
      .withPermits(1)(allocate(workspacePath))
      .pipe(
        Effect.mapError(
          (cause) =>
            new WorkspacePortAllocationError({
              workspacePath,
              cause,
            }),
        ),
      );

  const environmentFor: WorkspacePortAllocator["Service"]["environmentFor"] = (workspacePath) =>
    getBasePort(workspacePath).pipe(
      Effect.map((basePort) => ({ [WORKSPACE_PORT_ENV_VAR]: String(basePort) })),
    );

  return WorkspacePortAllocator.of({ getBasePort, environmentFor });
});

export const layer = Layer.effect(WorkspacePortAllocator, make());
