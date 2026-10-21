// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
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
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import { decideProviderAutoUpdate } from "../ProviderAutoUpdater.ts";
import { makeClaudeMaintenance } from "./ClaudeDriver.ts";

// A native Claude Code install already on the tested version.
const claude: ServerProvider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.1.302",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  versionAdvisory: {
    status: "current",
    currentVersion: "2.1.302",
    latestVersion: "2.1.302",
    updateCommand: "claude update",
    canUpdate: true,
    canInstallVersion: true,
    checkedAt: "2026-10-01T00:00:00.000Z",
    message: null,
  },
};

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

        const configDir = NodePath.join(home, ".claude");
        const settingsPath = NodePath.join(configDir, "settings.json");
        const resolve = resolveProviderMaintenanceCapabilitiesEffect(
          makeClaudeMaintenance({
            configDir,
            accountConfigPath: NodePath.join(home, ".claude.json"),
          }),
          { binaryPath, env: { PATH: "" } },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));
        const capabilities = yield* resolve;

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

        // `claude install` protects native auto-updates, so only styal's switch turns them off.
        yield* fs.writeFileString(
          NodePath.join(home, ".claude.json"),
          JSON.stringify({
            installMethod: "native",
            autoUpdates: false,
            autoUpdatesProtectedForNative: true,
          }),
        );
        const active = (yield* resolve).selfUpdaterActive;
        expect(active).toBe(true);
        // Managed updates take it over with a pinned reinstall of the same version.
        expect(decideProviderAutoUpdate(claude, "2.1.302", active)).toEqual({
          version: "2.1.302",
          takeover: true,
        });
        yield* capabilities.selfUpdater!.turnOff;
        expect(JSON.parse(yield* fs.readFileString(settingsPath))).toEqual({
          env: { DISABLE_AUTOUPDATER: "1", STYAL_MANAGED_UPDATES: "1" },
        });
        const off = (yield* resolve).selfUpdaterActive;
        expect(off).toBe(false);
        expect(decideProviderAutoUpdate(claude, "2.1.302", off)).toBe(null);
        yield* capabilities.selfUpdater!.handBack;
        expect((yield* resolve).selfUpdaterActive).toBe(true);
      }).pipe(Effect.scoped),
  );
});
