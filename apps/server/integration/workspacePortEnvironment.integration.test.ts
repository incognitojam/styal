import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { TerminalEvent } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory } from "../src/persistence/Sqlite.ts";
import * as ProcessRunner from "../src/processRunner.ts";
import * as TerminalManager from "../src/terminal/Manager.ts";
import * as NodePtyAdapter from "../src/terminal/NodePtyAdapter.ts";
import * as WorkspacePortAllocator from "../src/workspace/WorkspacePortAllocator.ts";

const integrationLayer = it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    layerMemory,
    ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
  ),
);

integrationLayer("workspace port environment integration", (it) => {
  it.effect("an actual terminal recovers from a full pool and retains stable workspace ports", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const platform = yield* HostProcess.Platform;
      const workspacePath = yield* fs.makeTempDirectoryScoped({
        prefix: "workspace-port-terminal-proof-",
      });

      const firstAllocator = yield* WorkspacePortAllocator.make();
      const allocatedPort = yield* firstAllocator.getBasePort(workspacePath);
      const reloadedAllocator = yield* WorkspacePortAllocator.make();
      const persistedPort = yield* reloadedAllocator.getBasePort(workspacePath);
      assert.strictEqual(persistedPort, allocatedPort);

      const allPorts = Array.from(
        {
          length:
            (WorkspacePortAllocator.WORKSPACE_PORT_MAX -
              WorkspacePortAllocator.WORKSPACE_PORT_MIN) /
              WorkspacePortAllocator.WORKSPACE_PORT_RANGE_SIZE +
            1,
        },
        (_, index) =>
          WorkspacePortAllocator.WORKSPACE_PORT_MIN +
          index * WorkspacePortAllocator.WORKSPACE_PORT_RANGE_SIZE,
      );
      yield* sql`INSERT INTO workspace_port_allocations ${sql.insert(
        allPorts
          .filter((port) => port !== allocatedPort)
          .map((port) => ({
            workspace_path: path.join(workspacePath, `deleted-${port}`),
            base_port: port,
          })),
      )}`;
      const newWorkspacePath = path.join(workspacePath, "new-workspace");
      yield* fs.makeDirectory(newWorkspacePath);

      const ptyAdapter = yield* NodePtyAdapter.make();
      const terminalManager = yield* TerminalManager.makeWithOptions({
        logsDir: path.join(workspacePath, ".terminal-logs"),
        ptyAdapter,
        shellResolver: () => (platform === "win32" ? "powershell.exe" : "/bin/sh"),
        resolveWorkspaceEnvironment: reloadedAllocator.environmentFor,
      });
      const output = yield* Ref.make("");
      const completed = yield* Deferred.make<TerminalEvent>();
      const unsubscribe = yield* terminalManager.subscribe((event) =>
        event.type === "output"
          ? Ref.update(output, (current) => current + event.data)
          : event.type === "exited" || event.type === "error"
            ? Deferred.succeed(completed, event).pipe(Effect.asVoid)
            : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* terminalManager.openCommand({
        threadId: "workspace-port-proof-thread",
        terminalId: "workspace-port-proof-terminal",
        cwd: newWorkspacePath,
        worktreePath: newWorkspacePath,
        command:
          "node -e \"process.stdout.write('PORT_PROOF=' + process.env.STYAL_WORKSPACE_PORT + ':' + process.env.T3CODE_WORKSPACE_PORT)\"",
      });

      const completion = yield* Deferred.await(completed);
      const observedOutput = yield* Ref.get(output);
      assert.strictEqual(completion.type, "exited");
      if (completion.type === "exited") assert.strictEqual(completion.exitCode, 0);
      const recoveredPort = yield* reloadedAllocator.getBasePort(newWorkspacePath);
      assert.notStrictEqual(recoveredPort, allocatedPort);
      assert.include(observedOutput, `PORT_PROOF=${recoveredPort}:${recoveredPort}`);
      assert.strictEqual(yield* reloadedAllocator.getBasePort(workspacePath), allocatedPort);

      if (process.env.T3CODE_PRINT_WORKSPACE_PORT_PROOF === "1") {
        yield* Effect.sync(() =>
          process.stdout.write(
            `workspace port proof: allocated=${allocatedPort} persisted=${persistedPort} recovered=${recoveredPort} child=${observedOutput.trim()}\n`,
          ),
        );
      }
    }),
  );
});
