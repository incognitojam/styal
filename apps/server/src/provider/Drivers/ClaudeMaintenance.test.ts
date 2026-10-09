// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  makeTargetedProviderUpdateAction,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodePath from "node:path";

import { CLAUDE_MAINTENANCE } from "./ClaudeDriver.ts";

const noSpawn = ChildProcessSpawner.make(() => Effect.die("Resolving Claude must not spawn"));

it.layer(NodeServices.layer)("Claude maintenance", (it) => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "updates a native install to the latest release manually and pins it in the background",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs
          .makeTempDirectoryScoped({ prefix: "styal-claude-native-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const binaryPath = NodePath.join(home, ".local", "bin", "claude");
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
        yield* fs.chmod(binaryPath, 0o755);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          CLAUDE_MAINTENANCE,
          { binaryPath, env: { PATH: "" } },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

        expect(capabilities.update).toMatchObject({
          executable: binaryPath,
          args: ["update"],
          lockKey: "claudeAgent-native",
        });
        expect(makeTargetedProviderUpdateAction(capabilities, "2.1.302")).toMatchObject({
          executable: binaryPath,
          args: ["install", "2.1.302"],
          lockKey: "claudeAgent-native",
        });
      }).pipe(Effect.scoped),
  );
});
