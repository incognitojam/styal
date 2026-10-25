// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  createProviderVersionAdvisory,
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
const windowsNativePath = "C:\\Users\\Dev Team's\\.local\\bin\\claude.exe";
const windowsWinGetPath =
  "C:\\Users\\Developer\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe";

it.layer(NodeServices.layer)("Claude maintenance", (it) => {
  it.effect("pins Windows native Claude and takes over and hands back its own updater", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "styal-claude-windows-" });
      const configDir = NodePath.join(home, ".claude");
      const settingsPath = NodePath.join(configDir, "settings.json");
      const accountConfigPath = NodePath.join(home, ".claude.json");
      yield* fs.makeDirectory(configDir);
      const original = { model: "opus", env: { SYNTHETIC_SETTING: "keep" } };
      yield* fs.writeFileString(settingsPath, JSON.stringify(original));
      yield* fs.writeFileString(
        accountConfigPath,
        JSON.stringify({
          installMethod: "native",
          autoUpdates: false,
          autoUpdatesProtectedForNative: true,
        }),
      );
      // Supply Windows discovery results without installing or running a provider.
      const resolve = makeClaudeMaintenance({ configDir, accountConfigPath }).resolve({
        binaryPath: "claude",
        resolvedCommandPath: windowsNativePath,
        realCommandPath: windowsNativePath,
        env: {},
        platform: "win32",
      });
      const capabilities = yield* resolve;
      expect(capabilities.update).toMatchObject({
        executable: windowsNativePath,
        args: ["update"],
        command: "& 'C:\\Users\\Dev Team''s\\.local\\bin\\claude.exe' update",
        lockKey: "claudeAgent-native",
      });
      expect(makeTargetedProviderUpdateAction(capabilities, "2.1.302")).toEqual({
        executable: windowsNativePath,
        args: ["install", "2.1.302"],
        command: "& 'C:\\Users\\Dev Team''s\\.local\\bin\\claude.exe' install 2.1.302",
        lockKey: capabilities.update?.lockKey,
      });
      for (const invalid of ["latest", "2.1.302-beta.1", "2.1.302; Write-Output unexpected"]) {
        expect(makeTargetedProviderUpdateAction(capabilities, invalid)).toBeNull();
      }
      const provider = {
        ...claude,
        versionAdvisory: createProviderVersionAdvisory({
          driver: claude.driver,
          currentVersion: claude.version ?? null,
          maintenanceCapabilities: capabilities,
        }),
      };
      expect(provider.versionAdvisory.canInstallVersion).toBe(true);
      expect(capabilities.selfUpdaterActive).toBe(true);
      expect(decideProviderAutoUpdate(provider, "2.1.302", capabilities.selfUpdaterActive)).toEqual(
        {
          version: "2.1.302",
          takeover: true,
        },
      );
      expect(
        decideProviderAutoUpdate({ ...provider, version: "2.1.303" }, "2.1.302", true),
      ).toBeNull();
      yield* capabilities.selfUpdater!.turnOff;
      expect(JSON.parse(yield* fs.readFileString(settingsPath))).toEqual({
        ...original,
        env: { ...original.env, DISABLE_AUTOUPDATER: "1", STYAL_MANAGED_UPDATES: "1" },
      });
      expect((yield* resolve).selfUpdaterActive).toBe(false);
      yield* capabilities.selfUpdater!.handBack;
      expect(JSON.parse(yield* fs.readFileString(settingsPath))).toEqual(original);
      expect((yield* resolve).selfUpdaterActive).toBe(true);

      const userOwned = { ...original, env: { ...original.env, DISABLE_AUTOUPDATER: "0" } };
      yield* fs.writeFileString(settingsPath, JSON.stringify(userOwned));
      expect((yield* resolve).selfUpdaterActive).toBeNull();
      yield* capabilities.selfUpdater!.turnOff;
      yield* capabilities.selfUpdater!.handBack;
      expect(JSON.parse(yield* fs.readFileString(settingsPath))).toEqual(userOwned);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
      Effect.scoped,
    ),
  );

  it.effect.each([
    { resolved: windowsWinGetPath, real: windowsWinGetPath, manualOnly: true },
    {
      resolved: "C:\\Program Files\\WinGet\\Links\\claude.exe",
      real: windowsWinGetPath,
      manualOnly: true,
    },
    { resolved: windowsNativePath, real: windowsWinGetPath, manualOnly: true },
    {
      resolved: "C:\\Tools\\claude.exe",
      real: "C:\\Tools\\claude.exe",
      manualOnly: false,
    },
    {
      resolved: "C:\\ProgramData\\chocolatey\\bin\\claude.exe",
      real: "C:\\ProgramData\\chocolatey\\bin\\claude.exe",
      manualOnly: false,
    },
    {
      resolved: "C:\\Work\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
      real: "C:\\Work\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
      manualOnly: true,
    },
  ])("does not pin Windows Claude at $resolved (real path $real)", (fixture) =>
    Effect.gen(function* () {
      const capabilities = yield* makeClaudeMaintenance({
        configDir: "unused-synthetic-config",
        accountConfigPath: "unused-synthetic-config.json",
      }).resolve({
        binaryPath: fixture.resolved,
        resolvedCommandPath: fixture.resolved,
        realCommandPath: fixture.real,
        env: {},
        platform: "win32",
      });
      expect(makeTargetedProviderUpdateAction(capabilities, "2.1.302")).toBeNull();
      expect(capabilities.selfUpdaterActive).toBeUndefined();
      expect(capabilities.selfUpdater).toBeUndefined();
      expect(capabilities.update === null).toBe(fixture.manualOnly);
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn)),
  );

  it.effect(
    "updates a native install to the latest release manually and pins it in the background",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs
          .makeTempDirectoryScoped({ prefix: "styal-claude-native space-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const windows = HostProcess.Platform.defaultValue() === "win32";
        const binaryPath = NodePath.join(home, ".local", "bin", windows ? "claude.exe" : "claude");
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
        if (!windows) yield* fs.chmod(binaryPath, 0o755);

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

        // The user keeps Claude's updater on themselves: no takeover reinstall.
        yield* fs.writeFileString(
          settingsPath,
          JSON.stringify({ env: { DISABLE_AUTOUPDATER: "0" } }),
        );
        const userOwned = (yield* resolve).selfUpdaterActive;
        expect(userOwned).toBe(null);
        expect(decideProviderAutoUpdate(claude, "2.1.302", userOwned)).toBe(null);
      }).pipe(Effect.scoped),
  );
});
