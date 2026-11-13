import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
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
      const first = (yield* allocator.getBasePort("/repo/worktrees/feature/../feature"))!;
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
        assert.strictEqual(port! % WorkspacePortAllocator.WORKSPACE_PORT_RANGE_SIZE, 0);
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
      const path = yield* Path.Path;
      const allocator = yield* WorkspacePortAllocator.WorkspacePortAllocator;
      const released = yield* allocator.getBasePort("/repo/worktrees/released");
      const kept = yield* allocator.getBasePort("/repo/worktrees/kept");

      yield* allocator.release("/repo/worktrees/released/");
      yield* allocator.release("/repo/worktrees/never-allocated");

      const stored = ["/repo/worktrees/released", "/repo/worktrees/kept"].map((workspacePath) =>
        path.resolve(workspacePath),
      );
      const rows = yield* sql<{ readonly workspacePath: string }>`
        SELECT workspace_path AS "workspacePath" FROM workspace_port_allocations
        WHERE ${sql.in("workspace_path", stored)}
      `;
      assert.deepStrictEqual(
        rows.map(({ workspacePath }) => workspacePath),
        [stored[1]],
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
  const rows = Arr.makeBy(
    (WorkspacePortAllocator.WORKSPACE_PORT_MAX - WorkspacePortAllocator.WORKSPACE_PORT_MIN) /
      WorkspacePortAllocator.WORKSPACE_PORT_RANGE_SIZE +
      1,
    (index) => ({
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

const holders = (input: {
  readonly open: ReadonlyArray<string>;
  readonly lastActivityMs?: ReadonlyArray<readonly [string, number]>;
  readonly onSnapshot?: () => void;
}) =>
  WorkspacePortAllocator.WorkspacePortHolders.of({
    snapshot: Effect.sync(() => {
      input.onSnapshot?.();
      return {
        openPaths: new Set(input.open),
        lastActivityMs: new Map(input.lastActivityMs ?? []),
      };
    }),
  });

const reservedPaths = Effect.fn("reservedPaths")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly workspacePath: string }>`
    SELECT workspace_path AS "workspacePath" FROM workspace_port_allocations
  `;
  return new Set(rows.map(({ workspacePath }) => workspacePath));
});

/** Every path exists, except the ones the test says cannot be inspected. */
const allocatorWithExistingPaths = Effect.fn("allocatorWithExistingPaths")(function* (input: {
  readonly holders: WorkspacePortAllocator.WorkspacePortHolders["Service"];
  readonly uninspectable?: ReadonlyArray<string>;
  readonly listeningPorts?: ReadonlyArray<number>;
}) {
  const fs = yield* FileSystem.FileSystem;
  return yield* WorkspacePortAllocator.make({
    hasListener: (port) => Effect.succeed(input.listeningPorts?.includes(port) ?? false),
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, {
      ...fs,
      stat: (workspacePath) =>
        input.uninspectable?.includes(workspacePath)
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "stat",
                pathOrDescriptor: workspacePath,
              }),
            )
          : fs.stat("."),
    }),
    Effect.provideService(WorkspacePortAllocator.WorkspacePortHolders, input.holders),
  );
});

it.effect("a full pool of open workspaces leaves new workspaces without ports", () =>
  Effect.gen(function* () {
    const rows = yield* fillPortPool("/synthetic/workspaces");
    let snapshots = 0;
    const allocator = yield* allocatorWithExistingPaths({
      holders: holders({
        open: rows.slice(1).map((row) => row.workspace_path),
        onSnapshot: () => {
          snapshots += 1;
        },
      }),
      uninspectable: [rows[0]!.workspace_path],
    });

    assert.isNull(yield* allocator.getBasePort("/synthetic/new-workspace"));
    assert.deepStrictEqual(yield* allocator.environmentFor("/synthetic/new-workspace"), {});
    assert.strictEqual((yield* reservedPaths()).size, rows.length);
    assert.strictEqual(yield* allocator.getBasePort(rows[0]!.workspace_path), rows[0]!.base_port);
    // A pass that freed nothing is not repeated for every request.
    assert.strictEqual(snapshots, 1);
    yield* TestClock.adjust("61 seconds");
    assert.isNull(yield* allocator.getBasePort("/synthetic/other-workspace"));
    assert.strictEqual(snapshots, 2);
  }).pipe(Effect.provide(isolatedLayer)),
);

it.effect("a full pool reclaims the least recently active closed workspaces", () =>
  Effect.gen(function* () {
    const rows = yield* fillPortPool("/synthetic/workspaces");
    const closed = rows.slice(10, 20);
    const withoutThread = rows[20]!;
    const allocator = yield* allocatorWithExistingPaths({
      holders: holders({
        open: rows
          .filter((row) => !closed.includes(row) && row !== withoutThread)
          .map((row) => row.workspace_path),
        lastActivityMs: closed.map((row, index) => [row.workspace_path, 1_000 + index] as const),
      }),
    });

    const port = yield* allocator.getBasePort("/synthetic/new-workspace");

    // The workspace with no thread goes first, then the oldest closed ones, up to the margin.
    const reclaimed = [withoutThread, ...closed.slice(0, 7)];
    assert.include(
      reclaimed.map((row) => row.base_port),
      port,
    );
    const reserved = yield* reservedPaths();
    for (const row of reclaimed) assert.isFalse(reserved.has(row.workspace_path));
    for (const row of closed.slice(7)) assert.isTrue(reserved.has(row.workspace_path));
    assert.strictEqual(reserved.size, rows.length - reclaimed.length + 1);
  }).pipe(Effect.provide(isolatedLayer)),
);

it.effect("a closed workspace whose ports have a listener keeps its range", () =>
  Effect.gen(function* () {
    const rows = yield* fillPortPool("/synthetic/workspaces");
    const [serving, idle] = [rows[10]!, rows[11]!];
    const allocator = yield* allocatorWithExistingPaths({
      holders: holders({
        open: rows
          .filter((row) => row !== serving && row !== idle)
          .map((row) => row.workspace_path),
        lastActivityMs: [
          [serving.workspace_path, 1_000],
          [idle.workspace_path, 2_000],
        ],
      }),
      listeningPorts: [serving.base_port + 7],
    });

    assert.strictEqual(yield* allocator.getBasePort("/synthetic/new-workspace"), idle.base_port);
    const reserved = yield* reservedPaths();
    assert.isTrue(reserved.has(serving.workspace_path));
    assert.isFalse(reserved.has(idle.workspace_path));
  }).pipe(Effect.provide(isolatedLayer)),
);

it.effect("a closed workspace keeps its range while a terminal or a recent hand-out uses it", () =>
  Effect.gen(function* () {
    const rows = yield* fillPortPool("/synthetic/workspaces");
    const [inTerminal, justUsed, idle] = [rows[10]!, rows[11]!, rows[12]!];
    const allocator = yield* allocatorWithExistingPaths({
      holders: holders({
        open: rows
          .slice(13)
          .concat(rows.slice(0, 10))
          .map((row) => row.workspace_path),
        lastActivityMs: [inTerminal, justUsed, idle].map(
          (row, index) => [row.workspace_path, index] as const,
        ),
      }),
    });
    yield* allocator.holdForTerminal({
      threadId: "thread-a",
      terminalId: "shell",
      workspacePath: inTerminal.workspace_path,
    });
    assert.strictEqual(yield* allocator.getBasePort(justUsed.workspace_path), justUsed.base_port);

    assert.strictEqual(yield* allocator.getBasePort("/synthetic/new-workspace"), idle.base_port);
    const reserved = yield* reservedPaths();
    assert.isTrue(reserved.has(inTerminal.workspace_path));
    assert.isTrue(reserved.has(justUsed.workspace_path));

    yield* allocator.releaseTerminalHold({ threadId: "thread-a", terminalId: "shell" });
    assert.strictEqual(
      yield* allocator.getBasePort("/synthetic/second-workspace"),
      inTerminal.base_port,
    );
  }).pipe(Effect.provide(isolatedLayer)),
);

it.effect("concurrent allocations at capacity each take a different reclaimed range", () =>
  Effect.gen(function* () {
    const rows = yield* fillPortPool("/synthetic/workspaces");
    const closed = rows.slice(0, 3);
    const allocator = yield* allocatorWithExistingPaths({
      holders: holders({
        open: rows.slice(3).map((row) => row.workspace_path),
        lastActivityMs: closed.map((row, index) => [row.workspace_path, index] as const),
      }),
    });

    const ports = yield* Effect.forEach(
      ["/synthetic/new-a", "/synthetic/new-b", "/synthetic/new-c", "/synthetic/new-d"],
      allocator.getBasePort,
      { concurrency: "unbounded" },
    );

    assert.sameMembers(
      ports.filter((port) => port !== null),
      closed.map((row) => row.base_port),
    );
    assert.strictEqual(ports.filter((port) => port === null).length, 1);
  }).pipe(Effect.provide(isolatedLayer)),
);
