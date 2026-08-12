import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { TerminalEvent } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../src/processRunner.ts";
import * as TerminalManager from "../src/terminal/Manager.ts";
import * as NodePtyAdapter from "../src/terminal/NodePtyAdapter.ts";
import * as WorkspacePortAllocator from "../src/workspace/WorkspacePortAllocator.ts";

const integrationLayer = it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    SqlitePersistenceMemory,
    ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
  ),
);

integrationLayer("workspace port environment integration", (it) => {
  it.effect("an actual terminal child sees the same port loaded by a new allocator", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcessPlatform;
      const workspacePath = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-workspace-port-proof-",
      });

      const firstAllocator = yield* WorkspacePortAllocator.make();
      const allocatedPort = yield* firstAllocator.getBasePort(workspacePath);
      const reloadedAllocator = yield* WorkspacePortAllocator.make();
      const persistedPort = yield* reloadedAllocator.getBasePort(workspacePath);
      assert.strictEqual(persistedPort, allocatedPort);

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
        cwd: workspacePath,
        worktreePath: workspacePath,
        command:
          "node -e \"process.stdout.write('PORT_PROOF=' + process.env.T3CODE_WORKSPACE_PORT)\"",
      });

      const completion = yield* Deferred.await(completed);
      const observedOutput = yield* Ref.get(output);
      assert.strictEqual(completion.type, "exited");
      if (completion.type === "exited") assert.strictEqual(completion.exitCode, 0);
      assert.include(observedOutput, `PORT_PROOF=${allocatedPort}`);

      if (process.env.T3CODE_PRINT_WORKSPACE_PORT_PROOF === "1") {
        yield* Effect.sync(() =>
          process.stdout.write(
            `workspace port proof: allocated=${allocatedPort} persisted=${persistedPort} child=${observedOutput.trim()}\n`,
          ),
        );
      }
    }),
  );
});
