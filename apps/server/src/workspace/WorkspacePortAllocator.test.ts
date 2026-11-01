import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory } from "../persistence/Sqlite.ts";
import * as WorkspacePortAllocator from "./WorkspacePortAllocator.ts";

const allocatorLayer = it.layer(
  WorkspacePortAllocator.layer.pipe(
    Layer.provideMerge(layerMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

allocatorLayer("WorkspacePortAllocator", (it) => {
  it.effect("keeps a workspace's ten-port range stable", () =>
    Effect.gen(function* () {
      const allocator = yield* WorkspacePortAllocator.WorkspacePortAllocator;
      const first = yield* allocator.getBasePort("/repo/worktrees/feature/../feature");
      const repeated = yield* allocator.getBasePort("/repo/worktrees/feature");
      const reloadedAllocator = yield* WorkspacePortAllocator.make();
      const afterReload = yield* reloadedAllocator.getBasePort("/repo/worktrees/feature");

      assert.strictEqual(repeated, first);
      assert.strictEqual(afterReload, first);
      assert.isAtLeast(first, WorkspacePortAllocator.WORKSPACE_PORT_MIN);
      assert.isAtMost(first, WorkspacePortAllocator.WORKSPACE_PORT_MAX);
      assert.strictEqual(first % WorkspacePortAllocator.WORKSPACE_PORT_RANGE_SIZE, 0);
    }),
  );

  it.effect("assigns non-overlapping ranges and exposes the first port", () =>
    Effect.gen(function* () {
      const allocator = yield* WorkspacePortAllocator.WorkspacePortAllocator;
      const ports = yield* Effect.forEach(
        Array.from({ length: 64 }, (_, index) => `/repo/worktrees/workspace-${index}`),
        allocator.getBasePort,
        { concurrency: "unbounded" },
      );

      assert.strictEqual(new Set(ports).size, ports.length);
      for (const port of ports) {
        assert.strictEqual(port % WorkspacePortAllocator.WORKSPACE_PORT_RANGE_SIZE, 0);
      }

      const environment = yield* allocator.environmentFor("/repo/worktrees/workspace-0");
      assert.strictEqual(
        environment[WorkspacePortAllocator.WORKSPACE_PORT_ENV_VAR],
        String(ports[0]),
      );
      assert.strictEqual(environment.T3CODE_WORKSPACE_PORT, String(ports[0]));
    }),
  );

  it.effect("release drops the reservation and leaves other workspaces alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const allocator = yield* WorkspacePortAllocator.WorkspacePortAllocator;
      const released = yield* allocator.getBasePort("/repo/worktrees/released");
      const kept = yield* allocator.getBasePort("/repo/worktrees/kept");

      yield* allocator.release("/repo/worktrees/released/");
      yield* allocator.release("/repo/worktrees/never-allocated");

      const rows = yield* sql<{ readonly workspacePath: string }>`
        SELECT workspace_path AS "workspacePath" FROM workspace_port_allocations
        WHERE workspace_path IN ('/repo/worktrees/released', '/repo/worktrees/kept')
      `;
      assert.deepStrictEqual(
        rows.map(({ workspacePath }) => workspacePath),
        ["/repo/worktrees/kept"],
      );
      assert.strictEqual(yield* allocator.getBasePort("/repo/worktrees/kept"), kept);
      assert.notStrictEqual(released, kept);
    }),
  );
});

const isolatedLayer = layerMemory.pipe(Layer.provideMerge(NodeServices.layer));

const fillPortPool = Effect.fn("fillPortPool")(function* (root: string) {
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;
  const rows = Array.from(
    {
      length:
        (WorkspacePortAllocator.WORKSPACE_PORT_MAX - WorkspacePortAllocator.WORKSPACE_PORT_MIN) /
          WorkspacePortAllocator.WORKSPACE_PORT_RANGE_SIZE +
        1,
    },
    (_, index) => ({
      workspace_path: path.join(root, `workspace-${index}`),
      base_port:
        WorkspacePortAllocator.WORKSPACE_PORT_MIN +
        index * WorkspacePortAllocator.WORKSPACE_PORT_RANGE_SIZE,
    }),
  );
  yield* sql`INSERT INTO workspace_port_allocations ${sql.insert(rows)}`;
  return rows;
});

it.effect("reclaims deleted workspaces at capacity while keeping existing ports stable", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "workspace-port-reclamation-",
    });
    const rows = yield* fillPortPool(root);
    const retained = rows[0]!;
    const removed = rows[1]!;
    yield* fs.makeDirectory(retained.workspace_path);
    yield* fs.makeDirectory(removed.workspace_path);
    yield* fs.remove(removed.workspace_path, { recursive: true });

    const allocator = yield* WorkspacePortAllocator.make();
    const newPaths = [path.join(root, "new-a"), path.join(root, "new-b")];
    yield* Effect.forEach(newPaths, (workspacePath) => fs.makeDirectory(workspacePath));
    const ports = yield* Effect.forEach(newPaths, allocator.getBasePort, {
      concurrency: "unbounded",
    });
    assert.strictEqual(new Set([retained.base_port, ...ports]).size, 3);
    assert.strictEqual(yield* allocator.getBasePort(retained.workspace_path), retained.base_port);

    const reloaded = yield* WorkspacePortAllocator.make();
    assert.strictEqual(yield* reloaded.getBasePort(newPaths[0]!), ports[0]);
    const environment = yield* reloaded.environmentFor(newPaths[1]!);
    assert.strictEqual(environment.STYAL_WORKSPACE_PORT, String(ports[1]));
    assert.strictEqual(environment.T3CODE_WORKSPACE_PORT, String(ports[1]));
    const reservations = yield* sql<{ readonly workspacePath: string }>`
      SELECT workspace_path AS "workspacePath" FROM workspace_port_allocations
    `;
    assert.sameMembers(
      reservations.map(({ workspacePath }) => workspacePath),
      [retained.workspace_path, ...newPaths],
    );
  }).pipe(Effect.provide(isolatedLayer)),
);

it.effect("retains a full pool when paths exist or cannot be inspected", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* fillPortPool("/synthetic/workspaces");
    const allocator = yield* WorkspacePortAllocator.make().pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        stat: (workspacePath) =>
          workspacePath === rows[0]!.workspace_path || workspacePath === rows[1]!.workspace_path
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: workspacePath === rows[0]!.workspace_path ? "PermissionDenied" : "Unknown",
                  module: "FileSystem",
                  method: "stat",
                  pathOrDescriptor: workspacePath,
                }),
              )
            : fs.stat("."),
      }),
    );

    const failure = yield* allocator.getBasePort("/synthetic/new-workspace").pipe(Effect.flip);
    assert.strictEqual(failure._tag, "WorkspacePortAllocationError");
    assert.propertyVal(failure.cause, "_tag", "WorkspacePortRangesExhaustedError");
    const reservations = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS "count" FROM workspace_port_allocations
    `;
    assert.strictEqual(reservations[0]!.count, rows.length);
    assert.strictEqual(yield* allocator.getBasePort(rows[0]!.workspace_path), rows[0]!.base_port);
    assert.strictEqual(yield* allocator.getBasePort(rows[1]!.workspace_path), rows[1]!.base_port);
  }).pipe(Effect.provide(isolatedLayer)),
);
