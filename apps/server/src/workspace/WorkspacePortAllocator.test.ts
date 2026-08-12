import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as WorkspacePortAllocator from "./WorkspacePortAllocator.ts";

const allocatorLayer = it.layer(
  WorkspacePortAllocator.layer.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
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
    }),
  );
});
