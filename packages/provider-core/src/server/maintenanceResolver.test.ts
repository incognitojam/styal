// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePathService from "@effect/platform-node/NodePath";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProviderLatestVersions from "./ProviderLatestVersions.ts";
import {
  createProviderVersionAdvisory,
  makeTargetedProviderUpdateAction,
  enrichProviderSnapshotWithVersionAdvisory,
  homebrewOwnershipFromCommandPath,
  invalidateLatestProviderVersion,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  npmGlobalPrefixFromCommandPath,
  parseHomebrewLatestVersion,
  resolveLatestProviderVersion,
  resolveProviderMaintenanceCapabilitiesEffect,
  resolvePackageManagedProviderMaintenance,
  type PackageManagedProviderMaintenanceDefinition,
  type ProviderMaintenanceCapabilities,
} from "./maintenanceResolver.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const driver = (value: string) => ProviderDriverKind.make(value);
// These write `#!/bin/sh` stubs and evaluate them with darwin/linux path
// semantics; a Windows temp path cannot be split on `:`.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const makeTempDir = (name: string) =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4()),
    Effect.map((id) => NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), `${name}-${id}`)),
  );
const isNativeTestCommandPath =
  (expectedPathSegment: string) =>
  (commandPath: string): boolean =>
    normalizeCommandPath(commandPath).includes(expectedPathSegment);
const packageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("packageTool"),
  npmPackageName: "@example/package-tool",
  nativeUpdate: null,
});
const nativePackageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("nativePackageTool"),
  npmPackageName: "@example/native-package-tool",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isNativeTestCommandPath("/.local/bin/native-package-tool"),
  },
});
const installedPackageToolProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("packageTool"),
  driver: driver("packageTool"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
const manualPackageTool: ProviderMaintenanceCapabilities = {
  provider: driver("packageTool"),
  packageName: "@example/package-tool",
  update: null,
};

function writeExecutable(path: string) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, "#!/bin/sh\n");
  NodeFS.chmodSync(path, 0o755);
}

function linkIntoPackage(tempDir: string, name: string, packageSegments: ReadonlyArray<string>) {
  const target = NodePath.join(tempDir, ...packageSegments, "bin", `${name}.js`);
  writeExecutable(target);
  const link = NodePath.join(tempDir, "bin", name);
  NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true });
  NodeFS.symlinkSync(target, link);
  return link;
}

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("maintenance resolution should not spawn a process here"),
);

function stdoutSpawner(
  onSpawn: (command: string, args: ReadonlyArray<string>) => string,
  exitCodeOf: (args: ReadonlyArray<string>) => number = () => 0,
) {
  return ChildProcessSpawner.make((command) => {
    const { command: executable, args } = command as unknown as {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    };
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCodeOf(args))),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(onSpawn(executable, args))),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
}

function customVitePlusFixture(platform: "linux" | "win32", homeOverride?: string) {
  const path = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const home =
    homeOverride ?? (platform === "win32" ? "D:\\Custom Tools\\vite-plus" : "/opt/custom-vp");
  const prefix = path.join(home, "js_runtime", "node", "24.21.0");
  const runtimeBin = platform === "win32" ? prefix : path.join(prefix, "bin");
  const modules = path.join(prefix, ...(platform === "win32" ? [] : ["lib"]), "node_modules");
  const shim = path.join(home, "bin", platform === "win32" ? "package-tool.cmd" : "package-tool");
  const real =
    platform === "win32"
      ? shim
      : path.join(modules, "@example", "package-tool", "bin", "package-tool.js");
  const node = path.join(runtimeBin, platform === "win32" ? "node.exe" : "node");
  const npmCli = path.join(modules, "npm", "bin", "npm-cli.js");
  const configPath = path.join(home, "bins", "package-tool.json");
  const config = {
    name: "package-tool",
    package: "@example/package-tool",
    nodeVersion: "24.21.0",
    source: "npm",
  };
  const files = new Map([
    [configPath, JSON.stringify(config)],
    [
      path.join(modules, "@example", "package-tool", "package.json"),
      JSON.stringify({ name: "@example/package-tool" }),
    ],
    [node, ""],
    [npmCli, ""],
    [path.join(runtimeBin, "package-tool.cmd"), "@echo off\r\n"],
    [
      shim,
      `@echo off\r\n"${path.join(runtimeBin, "package-tool.cmd")}" %*\r\nexit /b %ERRORLEVEL%\r\n`,
    ],
  ]);
  return {
    path,
    platform,
    home,
    prefix,
    runtimeBin,
    modules,
    shim,
    real,
    node,
    npmCli,
    files,
    configPath,
    config,
    env: { VP_HOME: home, PATH: platform === "win32" ? "C:\\other-runtime" : "/other-runtime/bin" },
    fileSystem: FileSystem.makeNoop({
      readFileString: (file) => Effect.succeed(files.get(file) ?? ""),
      exists: (file) => Effect.succeed(files.has(file)),
      realPath: (file) => Effect.succeed(file === shim ? real : file),
    }),
  };
}

it.layer(NodeServices.layer)("providerMaintenance", (it) => {
  it.effect("reads cached versions through ProviderLatestVersions", () =>
    resolveLatestProviderVersion(manualPackageTool).pipe(
      Effect.provideServiceEffect(
        ProviderLatestVersions.ProviderLatestVersions,
        ProviderLatestVersions.make([["@example/package-tool", "9.9.9"]]),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.die("cached provider version should not make an HTTP request"),
        ),
      ),
      Effect.map((version) => {
        expect(version).toBe("9.9.9");
      }),
    ),
  );

  it.effect("prefers the installer's own latest version over the npm registry", () =>
    resolveLatestProviderVersion({ ...manualPackageTool, latestVersion: "1.2.0" }).pipe(
      Effect.provide(ProviderLatestVersions.layer),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.die("installer-reported latest should not make an HTTP request"),
        ),
      ),
      Effect.map((version) => {
        expect(version).toBe("1.2.0");
      }),
    ),
  );

  it.effect("does not fetch latest provider versions when update checks are disabled", () =>
    enrichProviderSnapshotWithVersionAdvisory(
      { ...installedPackageToolProvider, installedVersion: "1.1.0" },
      manualPackageTool,
      { enableProviderUpdateChecks: false },
    ).pipe(
      Effect.provide(ProviderLatestVersions.layer),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.die("disabled provider update checks should not make an HTTP request"),
        ),
      ),
      Effect.map((provider) => {
        expect(provider.versionAdvisory).toMatchObject({
          status: "unknown",
          currentVersion: "1.1.0",
          latestVersion: null,
          checkedAt: "2026-04-10T00:00:00.000Z",
        });
      }),
    ),
  );

  it("marks providers with unknown current versions as unknown", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: null,
        latestVersion: "9.9.9",
      }),
    ).toMatchObject({
      status: "unknown",
      currentVersion: null,
      latestVersion: "9.9.9",
    });
  });

  it("marks providers with unknown latest versions as unknown", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: "1.0.0",
        latestVersion: null,
      }),
    ).toMatchObject({
      status: "unknown",
      currentVersion: "1.0.0",
      latestVersion: null,
      message: null,
    });
  });

  it("pins the advertised stable version in a pnpm-global update command", () => {
    const advisoryFor = (
      maintenanceCapabilities: ReturnType<typeof makeProviderMaintenanceCapabilities>,
      latestVersion: string,
    ) =>
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: "1.0.0",
        latestVersion,
        maintenanceCapabilities,
      }).updateCommand;
    const pnpmTool = makeProviderMaintenanceCapabilities({
      provider: driver("packageTool"),
      packageName: "@example/package-tool",
      updateExecutable: "pnpm",
      updateArgs: [
        "add",
        "-g",
        "--allow-build=@example/package-tool",
        "@example/package-tool@latest",
      ],
      updateLockKey: "pnpm-global",
    });

    expect(advisoryFor(pnpmTool, "1.1.0")).toBe(
      "pnpm add -g --allow-build=@example/package-tool @example/package-tool@1.1.0",
    );
    // A prerelease cannot be pinned safely, so pnpm keeps @latest.
    expect(advisoryFor(pnpmTool, "1.1.0-beta.1")).toBe(
      "pnpm add -g --allow-build=@example/package-tool @example/package-tool@latest",
    );
    // Only pnpm's minimumReleaseAge skips fresh releases; npm keeps @latest.
    expect(
      advisoryFor(
        makeProviderMaintenanceCapabilities({
          provider: driver("packageTool"),
          packageName: "@example/package-tool",
          updateExecutable: "npm",
          updateArgs: ["install", "-g", "@example/package-tool@latest"],
          updateLockKey: "npm-global:/opt/node",
        }),
        "1.1.0",
      ),
    ).toBe("npm install -g @example/package-tool@latest");
  });

  it("names the install to update when it is behind but unowned", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: "2.1.110",
        latestVersion: "2.1.117",
        maintenanceCapabilities: {
          ...manualPackageTool,
          installPath: "/Applications/Tool.app/Contents/Resources/bin/package-tool",
        },
      }),
    ).toMatchObject({
      status: "behind_latest",
      latestVersion: "2.1.117",
      updateCommand: null,
      canUpdate: false,
      message:
        "Version 2.1.117 is out. styal runs /Applications/Tool.app/Contents/Resources/bin/package-tool; update it with the app or tool that installed it.",
    });
  });

  it("offers the update when an owned install is behind", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: "2.1.110",
        latestVersion: "2.1.117",
        maintenanceCapabilities: makeProviderMaintenanceCapabilities({
          provider: driver("packageTool"),
          packageName: "@example/package-tool",
          updateExecutable: "npm",
          updateArgs: ["install", "-g", "@example/package-tool@latest"],
          updateLockKey: "npm-global:/usr/local",
        }),
      }),
    ).toMatchObject({
      status: "behind_latest",
      canUpdate: true,
      message: "Install the update now or review provider settings.",
    });
  });

  it.effect("stays manual-only when the binary cannot be located", () =>
    resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
      binaryPath: "package-tool",
      env: { PATH: "" },
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
      Effect.map((capabilities) => {
        expect(capabilities).toEqual(manualPackageTool);
      }),
    ),
  );

  it.effect.skipIf(!symlinksSupported)(
    "pins npm updates to the global prefix that owns the package",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-npm-capabilities");
        const link = linkIntoPackage(tempDir, "package-tool", [
          "lib",
          "node_modules",
          "@example",
          "package-tool",
        ]);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: link,
            env: { PATH: "" },
          },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

        expect(capabilities).toEqual({
          provider: driver("packageTool"),
          packageName: "@example/package-tool",
          update: {
            command: `npm install -g --prefix ${tempDir} --allow-scripts=@example/package-tool @example/package-tool@latest`,
            executable: "npm",
            args: [
              "install",
              "-g",
              "--prefix",
              tempDir,
              "--allow-scripts=@example/package-tool",
              "@example/package-tool@latest",
            ],
            lockKey: `npm-global:${normalizeCommandPath(tempDir)}`,
          },
        });
      }),
  );

  it("derives the npm prefix only from the global lib/node_modules layout", () => {
    expect(
      npmGlobalPrefixFromCommandPath(
        "/usr/local/lib/node_modules/@openai/codex/bin/codex.js",
        "@openai/codex",
      ),
    ).toBe("/usr/local");
    expect(
      npmGlobalPrefixFromCommandPath(
        "/usr/local/lib/node_modules/other/node_modules/@openai/codex/bin/codex.js",
        "@openai/codex",
      ),
    ).toBeNull();
    expect(
      npmGlobalPrefixFromCommandPath(
        "/lib/node_modules/@openai/codex/bin/codex.js",
        "@openai/codex",
      ),
    ).toBe("/");
    expect(
      npmGlobalPrefixFromCommandPath(
        "/work/app/node_modules/@openai/codex/bin/codex.js",
        "@openai/codex",
      ),
    ).toBeNull();
  });

  const claudeUpdate = {
    provider: driver("claudeAgent"),
    npmPackageName: "@anthropic-ai/claude-code",
    nativeUpdate: {
      args: ["update"],
      isCommandPath: isNativeTestCommandPath("/.local/bin/claude"),
    },
  };
  const otherProviderUpdate = {
    provider: driver("nativePackageTool"),
    npmPackageName: "@example/native-package-tool",
    nativeUpdate: {
      args: ["update"],
      isCommandPath: isNativeTestCommandPath("/.local/bin/native-package-tool"),
    },
  };
  const resolveInstall = (input: {
    readonly definition: PackageManagedProviderMaintenanceDefinition;
    readonly resolved: string;
    readonly real: string;
    readonly platform?: NodeJS.Platform;
    readonly env?: NodeJS.ProcessEnv;
  }) =>
    resolvePackageManagedProviderMaintenance(input.definition, {
      binaryPath: "claude",
      resolvedCommandPath: input.resolved,
      realCommandPath: input.real,
      env: input.env ?? {},
      platform: input.platform ?? "win32",
    }).pipe(
      Effect.provideService(HostProcess.Platform, input.platform ?? "win32"),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
    );
  const userWinGetLink = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe";
  const userWinGetPackage =
    "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe";
  const machineWinGetLink = "C:\\Program Files\\WinGet\\Links\\claude.exe";
  const machineWinGetPackage =
    "C:\\Program Files\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe";
  const nativeClaude = "C:\\Users\\me\\.local\\bin\\claude.exe";

  it.effect.each([
    { name: "a user-scope link", resolved: userWinGetLink, real: userWinGetPackage },
    { name: "a user-scope package", resolved: userWinGetPackage, real: userWinGetPackage },
    { name: "a machine-scope package", resolved: machineWinGetPackage, real: machineWinGetPackage },
    { name: "a machine-scope link alone", resolved: machineWinGetLink, real: machineWinGetLink },
    {
      name: "a mixed-case link",
      resolved: "c:\\USERS\\me\\appdata\\local\\MICROSOFT\\winget\\links\\Claude.EXE",
      real: userWinGetPackage.toUpperCase(),
    },
    { name: "a native-looking alias", resolved: nativeClaude, real: userWinGetPackage },
  ] as const)("keeps a WinGet Claude install manual-only through $name", (fixture) =>
    Effect.gen(function* () {
      const capabilities = yield* resolveInstall({ definition: claudeUpdate, ...fixture });

      expect(capabilities.update).toBeNull();
    }),
  );

  it.effect("hides update actions for a WinGet Claude install", () =>
    Effect.gen(function* () {
      const capabilities = yield* resolveInstall({
        definition: claudeUpdate,
        resolved: userWinGetLink,
        real: userWinGetPackage,
      });

      expect(
        createProviderVersionAdvisory({
          driver: driver("claudeAgent"),
          currentVersion: "2.1.0",
          latestVersion: "2.2.0",
          maintenanceCapabilities: capabilities,
        }),
      ).toMatchObject({ canUpdate: false, canInstallVersion: false, updateCommand: null });
    }),
  );

  it.effect.each([
    {
      name: "a native install",
      definition: claudeUpdate,
      resolved: nativeClaude,
      real: nativeClaude,
    },
    {
      name: "a WinGet-shaped path off Windows",
      definition: claudeUpdate,
      resolved: "/home/me/winget/links/claude.exe",
      real: "/home/me/winget/links/claude.exe",
      platform: "linux",
    },
    {
      name: "a WinGet-named folder outside the WinGet roots",
      definition: claudeUpdate,
      resolved: "C:\\Work\\WinGet\\Links\\claude.exe",
      real: "C:\\Work\\WinGet\\Links\\claude.exe",
    },
    {
      name: "a WinGet-named folder inside another directory",
      definition: claudeUpdate,
      resolved: "C:\\Work\\Microsoft\\WinGet\\Links\\claude.exe",
      real: "C:\\Work\\Microsoft\\WinGet\\Links\\claude.exe",
    },
    {
      name: "another provider in WinGet",
      definition: otherProviderUpdate,
      resolved: userWinGetLink,
      real: userWinGetPackage,
    },
    {
      name: "another WinGet package",
      definition: claudeUpdate,
      resolved: userWinGetPackage.replace("ClaudeCode_", "ClaudeCodeOther_"),
      real: userWinGetPackage.replace("ClaudeCode_", "ClaudeCodeOther_"),
    },
  ] as const)("keeps the native updater for $name", (fixture) =>
    Effect.gen(function* () {
      const capabilities = yield* resolveInstall(fixture);

      expect(capabilities.update).toMatchObject({
        executable: fixture.resolved,
        args: ["update"],
        lockKey: `${fixture.definition.provider}-native`,
      });
    }),
  );

  it.effect.each([
    {
      name: "the default home",
      resolved: "/Users/theo/.vite-plus/bin/claude",
      real: "/Users/theo/.vite-plus/current/bin/vp",
      platform: "darwin",
    },
    {
      name: "the XDG home",
      resolved: "/home/theo/.local/share/vite-plus/bin/claude",
      real: "/home/theo/.local/share/vite-plus/current/bin/vp",
      platform: "linux",
    },
    {
      name: "the Windows home",
      resolved: "C:\\Users\\Theo\\AppData\\Local\\vite-plus\\bin\\claude.cmd",
      real: "C:\\Users\\Theo\\AppData\\Local\\vite-plus\\packages\\@anthropic-ai\\claude-code\\lib\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
      platform: "win32",
    },
  ] as const)("updates a Vite+ global install in $name with vp", (fixture) =>
    Effect.gen(function* () {
      const capabilities = yield* resolveInstall({ definition: claudeUpdate, ...fixture });

      expect(capabilities.update).toMatchObject({
        command: "vp i -g @anthropic-ai/claude-code",
        lockKey: "vite-plus-global",
      });
    }),
  );

  it.effect("keeps a project folder named vite-plus manual-only", () =>
    Effect.gen(function* () {
      const capabilities = yield* resolveInstall({
        definition: claudeUpdate,
        resolved: "/work/vite-plus/bin/claude",
        real: "/work/vite-plus/node_modules/@anthropic-ai/claude-code/cli.js",
        platform: "linux",
      });

      expect(capabilities.update).toBeNull();
    }),
  );

  const resolveCustomVitePlus = (
    fixture: ReturnType<typeof customVitePlusFixture>,
    env: NodeJS.ProcessEnv = fixture.env,
  ) =>
    resolveInstall({
      definition: {
        provider: driver("packageTool"),
        npmPackageName: "@example/package-tool",
        nativeUpdate: { args: ["update"] },
      },
      resolved: fixture.shim,
      real: fixture.real,
      platform: fixture.platform,
      env,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fixture.fileSystem),
      Effect.provide(
        fixture.platform === "win32" ? NodePathService.layerWin32 : NodePathService.layerPosix,
      ),
    );

  it.effect.each(["linux", "win32"] as const)(
    "updates the npm runtime a custom VP_HOME shim runs on %s",
    (platform) =>
      Effect.gen(function* () {
        const fixture = customVitePlusFixture(platform);
        const capabilities = yield* resolveCustomVitePlus(fixture);
        expect(capabilities.update).toMatchObject({
          executable: fixture.node,
          args: [
            fixture.npmCli,
            "install",
            "-g",
            "--prefix",
            fixture.prefix,
            "--allow-scripts=@example/package-tool",
            "@example/package-tool@latest",
          ],
          lockKey: `npm-global:${normalizeCommandPath(fixture.prefix)}`,
          env: {
            VP_HOME: fixture.home,
            PATH: `${fixture.runtimeBin}${platform === "win32" ? ";" : ":"}${fixture.env.PATH}`,
          },
        });
        expect(
          createProviderVersionAdvisory({
            driver: driver("packageTool"),
            currentVersion: "1.0.0",
            latestVersion: "2.0.0",
            maintenanceCapabilities: capabilities,
          }).canInstallVersion,
        ).toBe(true);
        const pinned = makeTargetedProviderUpdateAction(capabilities, "2.0.0");
        expect(pinned).toEqual({
          ...capabilities.update,
          args: [...capabilities.update!.args.slice(0, -1), "@example/package-tool@2.0.0"],
          command: capabilities.update!.command.replace(
            "@example/package-tool@latest",
            "@example/package-tool@2.0.0",
          ),
        });
      }),
  );

  it.effect.each(["owned", "unrelated"] as const)(
    "checks the canonical npm prefix of a symlinked VP_HOME: %s",
    (installation) =>
      Effect.gen(function* () {
        const fixture = customVitePlusFixture("linux");
        const canonicalPrefix = "/volumes/tools/vite-plus/js_runtime/node/24.21.0";
        const realPrefix = installation === "owned" ? canonicalPrefix : "/volumes/other-runtime";
        const capabilities = yield* resolveCustomVitePlus({
          ...fixture,
          real: fixture.path.join(
            realPrefix,
            "lib/node_modules/@example/package-tool/bin/package-tool.js",
          ),
          fileSystem: {
            ...fixture.fileSystem,
            realPath: (file) => Effect.succeed(file === fixture.prefix ? canonicalPrefix : file),
          },
        });

        if (installation === "unrelated") {
          expect(capabilities.update).toBeNull();
          return;
        }
        expect(capabilities.update).toMatchObject({
          executable: fixture.node,
          args: [
            fixture.npmCli,
            "install",
            "-g",
            "--prefix",
            fixture.prefix,
            "--allow-scripts=@example/package-tool",
            "@example/package-tool@latest",
          ],
          lockKey: `npm-global:${normalizeCommandPath(canonicalPrefix)}`,
          env: { VP_HOME: fixture.home },
        });
        expect(makeTargetedProviderUpdateAction(capabilities, "2.0.0")?.args.at(-1)).toBe(
          "@example/package-tool@2.0.0",
        );
      }),
  );

  it.effect("uses the proven custom Vite+ launcher for a POSIX managed package link", () =>
    Effect.gen(function* () {
      const fixture = customVitePlusFixture("linux");
      const launcher = fixture.path.join(fixture.home, "current", "bin", "vp");
      fixture.files.set(fixture.configPath, JSON.stringify({ ...fixture.config, source: "vp" }));
      const capabilities = yield* resolveCustomVitePlus({ ...fixture, real: launcher });
      expect(capabilities.update).toMatchObject({
        executable: launcher,
        args: ["i", "-g", "@example/package-tool"],
        env: fixture.env,
        lockKey: "vite-plus-global",
      });
      expect(makeTargetedProviderUpdateAction(capabilities, "2.0.0")?.args).toEqual([
        "i",
        "-g",
        "@example/package-tool@2.0.0",
      ]);
    }),
  );

  const copiedVitePlusTrampoline = (home?: string) => {
    const fixture = customVitePlusFixture("win32", home);
    const shim = fixture.path.join(fixture.home, "bin", "package-tool.exe");
    const launcher = fixture.path.join(fixture.home, "current", "bin", "vp.exe");
    const sidecar = fixture.path.join(fixture.home, "bin", "package-tool.shim");
    fixture.files.set(fixture.configPath, JSON.stringify({ ...fixture.config, source: "vp" }));
    fixture.files.set(shim, "MZ synthetic copied trampoline");
    fixture.files.set(launcher, "MZ synthetic Vite+ payload");
    fixture.files.set(
      sidecar,
      `vite-plus-shim-v1\nlayout=single-root\ndata=${fixture.home}\ncache=${fixture.path.join(fixture.home, "cache")}\nbin=${fixture.path.join(fixture.home, "bin")}\n`,
    );
    const binaryReads: Array<{ file: string; limit: number }> = [];
    return {
      ...fixture,
      shim,
      real: shim,
      launcher,
      sidecar,
      binaryReads,
      fileSystem: FileSystem.makeNoop({
        ...fixture.fileSystem,
        stream: (file, options) => {
          const content = fixture.files.get(file);
          if (content === undefined) return fixture.fileSystem.stream(file, options);
          const limit = typeof options?.bytesToRead === "number" ? options.bytesToRead : Infinity;
          binaryReads.push({ file, limit });
          const bytes = new TextEncoder().encode(content).subarray(0, limit);
          return Stream.fromIterable([bytes.subarray(0, 8), bytes.subarray(8)]);
        },
      }),
    };
  };

  it.effect.each([
    "D:\\Custom Tools\\vite-plus",
    "C:\\Users\\Synthetic\\AppData\\Local\\vite-plus",
    "C:\\Users\\Synthetic\\.vite-plus",
  ])("updates a copied Windows Vite+ trampoline at %s with VP_HOME set", (home) =>
    Effect.gen(function* () {
      const fixture = copiedVitePlusTrampoline(home);
      expect(fixture.real).toBe(fixture.shim);
      expect(fixture.real).not.toBe(fixture.launcher);
      const capabilities = yield* resolveCustomVitePlus(fixture);
      expect(capabilities.update).toMatchObject({
        executable: fixture.launcher,
        args: ["i", "-g", "@example/package-tool"],
        env: fixture.env,
        lockKey: "vite-plus-global",
      });
      expect(makeTargetedProviderUpdateAction(capabilities, "2.0.0")?.args).toEqual([
        "i",
        "-g",
        "@example/package-tool@2.0.0",
      ]);
    }),
  );

  it.effect(
    "accepts a copied trampoline sidecar with BOM and CRLF without an optional bin field",
    () =>
      Effect.gen(function* () {
        const fixture = copiedVitePlusTrampoline();
        fixture.files.set(
          fixture.sidecar,
          `\uFEFFvite-plus-shim-v1\r\nlayout=single-root\r\ndata=${fixture.home}\r\n`,
        );
        expect((yield* resolveCustomVitePlus(fixture)).update?.executable).toBe(fixture.launcher);
      }),
  );

  it.effect.each([
    "D:\\Custom Tools\\vite-plus",
    "C:\\Users\\Synthetic\\AppData\\Local\\vite-plus",
    "C:\\Users\\Synthetic\\.vite-plus",
  ])(
    "updates a sidecar-free legacy copied trampoline at %s only when its payload matches",
    (home) =>
      Effect.gen(function* () {
        const fixture = copiedVitePlusTrampoline(home);
        fixture.files.delete(fixture.sidecar);
        const template = fixture.path.join(fixture.home, "current", "bin", "vp-shim.exe");
        fixture.files.set(template, fixture.files.get(fixture.shim)!);
        const capabilities = yield* resolveCustomVitePlus(fixture);
        expect(capabilities.update).toMatchObject({
          executable: fixture.launcher,
          env: fixture.env,
          lockKey: "vite-plus-global",
        });
        expect(fixture.binaryReads).toEqual([
          { file: fixture.shim, limit: 1_024 * 1_024 + 1 },
          { file: template, limit: 1_024 * 1_024 + 1 },
        ]);
        const contents = fixture.files.get(fixture.shim)!;
        fixture.files.set(fixture.shim, `${contents.slice(0, -1)}!`);
        expect((yield* resolveCustomVitePlus(fixture)).update).toBeNull();
      }),
  );

  it.effect.each(["empty", "oversized"])(
    "rejects %s legacy trampoline bytes with bounded reads",
    (failure) =>
      Effect.gen(function* () {
        const fixture = copiedVitePlusTrampoline();
        fixture.files.delete(fixture.sidecar);
        const contents = failure === "empty" ? "" : "M".repeat(1_024 * 1_024 + 2);
        fixture.files.set(fixture.shim, contents);
        fixture.files.set(
          fixture.path.join(fixture.home, "current", "bin", "vp-shim.exe"),
          contents,
        );
        expect((yield* resolveCustomVitePlus(fixture)).update).toBeNull();
        expect(fixture.binaryReads.every((read) => read.limit === 1_024 * 1_024 + 1)).toBe(true);
      }),
  );

  it.effect.each([
    "missing sidecar",
    "legacy sidecar",
    "unknown header",
    "another data root",
    "another bin root",
    "split layout",
    "unknown layout",
    "missing launcher",
  ])("rejects an unproven copied Vite+ trampoline: %s", (failure) =>
    Effect.gen(function* () {
      const fixture = copiedVitePlusTrampoline();
      const sidecar = fixture.files.get(fixture.sidecar)!;
      switch (failure) {
        case "missing sidecar":
          fixture.files.delete(fixture.sidecar);
          break;
        case "legacy sidecar":
          fixture.files.set(fixture.sidecar, `${fixture.home}\n`);
          break;
        case "unknown header":
          fixture.files.set(
            fixture.sidecar,
            sidecar.replace("vite-plus-shim-v1", "vite-plus-shim-v2"),
          );
          break;
        case "another data root":
          fixture.files.set(
            fixture.sidecar,
            sidecar.replace(`data=${fixture.home}`, "data=C:\\another-vp"),
          );
          break;
        case "another bin root":
          fixture.files.set(
            fixture.sidecar,
            sidecar.replace(
              `bin=${fixture.path.join(fixture.home, "bin")}`,
              "bin=C:\\another-vp\\bin",
            ),
          );
          break;
        case "split layout":
          fixture.files.set(fixture.sidecar, sidecar.replace("layout=single-root", "layout=split"));
          break;
        case "unknown layout":
          fixture.files.set(
            fixture.sidecar,
            sidecar.replace("layout=single-root", "layout=unknown"),
          );
          break;
        case "missing launcher":
          fixture.files.delete(fixture.launcher);
          break;
      }
      expect((yield* resolveCustomVitePlus(fixture)).update).toBeNull();
    }),
  );

  it.effect.each([
    "missing metadata",
    "invalid metadata",
    "another package",
    "another binary",
    "invalid runtime",
    "another runtime",
    "missing npm",
    "missing node",
    "another manifest",
    "delegated wrapper",
    "unproven managed shim",
    "unknown installer",
  ])("does not update an unproven custom Vite+ install: %s", (failure) =>
    Effect.gen(function* () {
      const fixture = customVitePlusFixture("win32");
      switch (failure) {
        case "missing metadata":
          fixture.files.delete(fixture.configPath);
          break;
        case "invalid metadata":
          fixture.files.set(fixture.configPath, "{");
          break;
        case "another package":
          fixture.files.set(
            fixture.configPath,
            JSON.stringify({ ...fixture.config, package: "@other/tool" }),
          );
          break;
        case "another binary":
          fixture.files.set(
            fixture.configPath,
            JSON.stringify({ ...fixture.config, name: "other" }),
          );
          break;
        case "invalid runtime":
          fixture.files.set(
            fixture.configPath,
            JSON.stringify({ ...fixture.config, nodeVersion: "../other" }),
          );
          break;
        case "another runtime":
          fixture.files.set(
            fixture.configPath,
            JSON.stringify({ ...fixture.config, nodeVersion: "22.0.0" }),
          );
          break;
        case "missing npm":
          fixture.files.delete(fixture.npmCli);
          break;
        case "missing node":
          fixture.files.delete(fixture.node);
          break;
        case "another manifest":
          fixture.files.set(
            fixture.path.join(fixture.modules, "@example", "package-tool", "package.json"),
            JSON.stringify({ name: "@other/tool" }),
          );
          break;
        case "delegated wrapper":
          fixture.files.set(
            fixture.shim,
            '@echo off\r\n"C:\\other-runtime\\package-tool.cmd" %*\r\nexit /b %ERRORLEVEL%\r\n',
          );
          break;
        case "unproven managed shim":
          fixture.files.set(
            fixture.configPath,
            JSON.stringify({ ...fixture.config, source: "vp" }),
          );
          break;
        case "unknown installer":
          fixture.files.set(
            fixture.configPath,
            JSON.stringify({ ...fixture.config, source: "other" }),
          );
          break;
      }
      expect((yield* resolveCustomVitePlus(fixture)).update).toBeNull();
    }),
  );

  it.effect("does not treat a project bin below VP_HOME as a global shim", () =>
    Effect.gen(function* () {
      const fixture = customVitePlusFixture("linux");
      const capabilities = yield* resolveCustomVitePlus({
        ...fixture,
        shim: fixture.path.join(fixture.home, "project", "vite-plus", "bin", "package-tool"),
        real: fixture.path.join(
          fixture.home,
          "project",
          "vite-plus",
          "node_modules",
          "@example",
          "package-tool",
          "bin",
          "package-tool.js",
        ),
      });
      expect(capabilities.update).toBeNull();
    }),
  );

  it.effect("does not send an old default install to a different VP_HOME", () =>
    Effect.gen(function* () {
      const capabilities = yield* resolveInstall({
        definition: claudeUpdate,
        resolved: "/home/synthetic/.vite-plus/bin/claude",
        real: "/home/synthetic/.vite-plus/current/bin/vp",
        platform: "linux",
        env: { VP_HOME: "/opt/other-vp" },
      });
      expect(capabilities.update).toBeNull();
    }),
  );

  it.effect("keeps POSIX VP_HOME ownership case sensitive", () =>
    Effect.gen(function* () {
      const fixture = customVitePlusFixture("linux");
      const capabilities = yield* resolveCustomVitePlus({
        ...fixture,
        shim: fixture.shim.toUpperCase(),
        real: fixture.shim.toUpperCase(),
      });
      expect(capabilities.update?.lockKey).not.toMatch(/^(?:vite-plus|npm)-global/);
    }),
  );

  it.effect("matches an npm-linked Windows wrapper across VP_HOME path casing", () =>
    Effect.gen(function* () {
      const fixture = customVitePlusFixture("win32");
      const files = new Map(
        [...fixture.files].map(([file, contents]) => [file.toLowerCase(), contents]),
      );
      const capabilities = yield* resolveCustomVitePlus(
        {
          ...fixture,
          fileSystem: FileSystem.makeNoop({
            readFileString: (file) => Effect.succeed(files.get(file.toLowerCase()) ?? ""),
            exists: (file) => Effect.succeed(files.has(file.toLowerCase())),
          }),
        },
        { ...fixture.env, VP_HOME: fixture.home.toLowerCase() },
      );
      expect(capabilities.update?.executable.toLowerCase()).toBe(fixture.node.toLowerCase());
      expect(makeTargetedProviderUpdateAction(capabilities, "2.0.0")?.args.at(-1)).toBe(
        "@example/package-tool@2.0.0",
      );
    }),
  );

  it.effect("accepts a custom root with a trailing separator and Windows Path spelling", () =>
    Effect.gen(function* () {
      const fixture = customVitePlusFixture("win32");
      const capabilities = yield* resolveCustomVitePlus(fixture, {
        VP_HOME: `${fixture.home}\\`,
        Path: "C:\\instance-runtime",
      });
      expect(capabilities.update?.executable).toBe(fixture.node);
      expect(capabilities.update?.env?.PATH).toBe(`${fixture.runtimeBin};C:\\instance-runtime`);
      expect(capabilities.update?.env).not.toHaveProperty("Path");
    }),
  );

  it.effect.each(["relative/vp", "D:relative-vp", "\\root-relative-vp"])(
    "ignores a non-absolute VP_HOME: %s",
    (home) =>
      Effect.gen(function* () {
        const capabilities = yield* resolveInstall({
          definition: claudeUpdate,
          resolved: "C:\\Users\\Synthetic\\AppData\\Local\\vite-plus\\bin\\claude.cmd",
          real: "C:\\Users\\Synthetic\\AppData\\Local\\vite-plus\\current\\bin\\vp.exe",
          platform: "win32",
          env: { VP_HOME: home },
        }).pipe(Effect.provide(NodePathService.layerWin32));
        expect(capabilities.update?.lockKey).toBe("vite-plus-global");
      }),
  );

  it.effect("uses the effective VP_HOME and PATH instead of the ambient configuration", () =>
    Effect.gen(function* () {
      const fixture = customVitePlusFixture("win32");
      const fileSystem = yield* FileSystem.FileSystem;
      const fileInfo = yield* fileSystem.stat(import.meta.filename);
      const instanceEnv = {
        VP_HOME: fixture.home,
        PATH: fixture.path.join(fixture.home, "bin"),
        PATHEXT: ".CMD",
      };
      const resolve = (
        env?: NodeJS.ProcessEnv,
        configuredEnv = {
          VP_HOME: "C:\\ambient-vp",
          PATH: "C:\\ambient-runtime",
          PATHEXT: ".CMD",
        },
      ) =>
        resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
          binaryPath: "package-tool",
          ...(env ? { env } : {}),
        }).pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: configuredEnv,
              }),
            ),
          ),
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provide(NodePathService.layerWin32),
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              ...fixture.fileSystem,
              stat: (file) =>
                file === fixture.shim ? Effect.succeed(fileInfo) : fixture.fileSystem.stat(file),
            }),
          ),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        );
      expect((yield* resolve()).update).toBeNull();
      expect((yield* resolve(undefined, instanceEnv)).update?.executable).toBe(fixture.node);
      const explicit = yield* resolve(instanceEnv);
      expect(explicit.update?.executable).toBe(fixture.node);
      expect(explicit.update?.env?.PATH).not.toContain("ambient");
      expect(explicit.update?.env?.VP_HOME).toBe(fixture.home);
    }),
  );

  it.effect("proves Windows npm ownership from the package manifest beside the shim", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-npm-windows-capabilities");
      const shim = NodePath.join(tempDir, "package-tool.cmd");
      NodeFS.mkdirSync(tempDir, { recursive: true });
      NodeFS.writeFileSync(shim, "@echo off\r\n");
      NodeFS.mkdirSync(NodePath.join(tempDir, "node_modules", "@example", "package-tool"), {
        recursive: true,
      });
      NodeFS.writeFileSync(
        NodePath.join(tempDir, "node_modules", "@example", "package-tool", "package.json"),
        "{}",
      );

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: shim,
        env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
      );

      expect(capabilities.update).toMatchObject({
        executable: "npm",
        args: ["install", "-g", "--prefix", tempDir, expect.any(String), expect.any(String)],
      });

      const script = NodePath.join(tempDir, "package-tool");
      writeExecutable(script);
      const posix = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: script,
        env: { PATH: "" },
      }).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
      );
      expect(posix.update).toBeNull();
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "switches to pnpm updates when the real path lives in pnpm's global store",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-pnpm-capabilities");
        const link = linkIntoPackage(tempDir, "package-tool", [
          ".local",
          "share",
          "pnpm",
          "global",
          "5",
          "node_modules",
          "@example",
          "package-tool",
        ]);

        const updateCommand = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
          resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
            binaryPath: link,
            env: { PATH: "" },
          }).pipe(
            Effect.map((capabilities) => capabilities.update),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
        const pnpmVersion = (version: string) =>
          stdoutSpawner((command, args) => {
            expect([command, ...args].join(" ")).toMatch(/pnpm(\.cmd)?"? --version$/);
            return `${version}
`;
          });

        expect(yield* updateCommand(pnpmVersion("11.1.3"))).toMatchObject({
          command: "pnpm add -g --allow-build=@example/package-tool @example/package-tool@latest",
          lockKey: "pnpm-global",
        });
        // Older pnpm rejects the unknown flag, and runs install scripts before 10.
        expect((yield* updateCommand(pnpmVersion("10.3.0")))?.command).toBe(
          "pnpm add -g @example/package-tool@latest",
        );
        expect((yield* updateCommand(noSpawn))?.command).toBe(
          "pnpm add -g @example/package-tool@latest",
        );
      }),
  );

  it.effect.each([
    {
      case: "the eligible release",
      outdated: { "@example/package-tool": { current: "1.0.0", latest: "1.1.0" } },
      exitCode: 1,
      expected: "1.1.0",
    },
    { case: "no update during cooldown", outdated: {}, exitCode: 0, expected: "1.0.0" },
    {
      case: "the npm fallback when the pnpm probe fails",
      outdated: { "@example/package-tool": { current: "1.0.0", latest: "1.1.0" } },
      exitCode: 2,
      expected: "9.9.9",
    },
  ])(
    "advertises $case for pnpm-global installs",
    (fixture) =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-pnpm-latest");
        const pnpmBinDir = NodePath.join(tempDir, "pnpm-bin");
        writeExecutable(NodePath.join(pnpmBinDir, "pnpm"));
        const link = linkIntoPackage(tempDir, "package-tool", [
          ".local",
          "share",
          "pnpm",
          "global",
          "5",
          "node_modules",
          "@example",
          "package-tool",
        ]);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          { binaryPath: link, env: { PATH: "" } },
        ).pipe(
          Effect.provideService(HostProcess.Environment, { PATH: pnpmBinDir }),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            stdoutSpawner(
              (_command, args) =>
                args[0] === "outdated"
                  ? JSON.stringify(fixture.outdated)
                  : JSON.stringify([
                      { dependencies: { "@example/package-tool": { version: "1.0.0" } } },
                    ]),
              (args) => (args[0] === "outdated" ? fixture.exitCode : 0),
            ),
          ),
        );

        const provider = yield* enrichProviderSnapshotWithVersionAdvisory(
          installedPackageToolProvider,
          capabilities,
        ).pipe(
          Effect.provideServiceEffect(
            ProviderLatestVersions.ProviderLatestVersions,
            ProviderLatestVersions.make([["@example/package-tool", "9.9.9"]]),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("the npm version is already cached")),
          ),
        );
        expect(provider.versionAdvisory).toMatchObject({
          status: fixture.expected === "1.0.0" ? "current" : "behind_latest",
          currentVersion: "1.0.0",
          latestVersion: fixture.expected,
        });
      }),
    { skip: !symlinksSupported || windowsHost },
  );

  it.effect.skipIf(windowsHost)(
    "switches to bun updates when the resolved binary lives in bun's global bin",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-bun-capabilities");
        const bunBinDir = NodePath.join(tempDir, ".bun", "bin");
        writeExecutable(NodePath.join(bunBinDir, "package-tool"));

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: "package-tool",
            env: { PATH: bunBinDir },
          },
        ).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        );

        expect(capabilities.update).toMatchObject({
          command: "bun i -g @example/package-tool@latest",
          lockKey: "bun-global",
        });
      }),
  );

  it.effect.skipIf(windowsHost)("switches to native updates and runs the resolved executable", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-native-capabilities");
      const nativeBinDir = NodePath.join(tempDir, ".local", "bin");
      const nativePath = NodePath.join(nativeBinDir, "native-package-tool");
      writeExecutable(nativePath);

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
        nativePackageToolUpdate,
        {
          binaryPath: "native-package-tool",
          env: { PATH: nativeBinDir },
        },
      ).pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
      );

      expect(capabilities).toEqual({
        provider: driver("nativePackageTool"),
        packageName: "@example/native-package-tool",
        update: {
          command: `${nativePath} update`,
          executable: nativePath,
          args: ["update"],
          lockKey: "nativePackageTool-native",
        },
      });
    }),
  );

  it.effect.each(["wrapper", "symlink"])(
    "keeps a mise-owned %s in a native install location manual-only",
    (launcher, { skip }) => {
      if (windowsHost || (launcher === "symlink" && !symlinksSupported)) skip();
      return Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-native-mise");
        const nativePath = NodePath.join(tempDir, ".local", "bin", "native-package-tool");
        if (launcher === "wrapper") {
          writeExecutable(nativePath);
          NodeFS.writeFileSync(
            nativePath,
            '#!/bin/sh\nexec mise x native-package-tool -- native-package-tool "$@"\n',
          );
        } else {
          const target = NodePath.join(
            tempDir,
            "mise",
            "installs",
            "native-package-tool",
            "1.0.0",
            "native-package-tool",
          );
          writeExecutable(target);
          NodeFS.mkdirSync(NodePath.dirname(nativePath), { recursive: true });
          NodeFS.symlinkSync(target, nativePath);
        }

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          nativePackageToolUpdate,
          { binaryPath: nativePath, env: { PATH: "" } },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

        expect(capabilities.update).toBeNull();
      });
    },
  );

  it.effect.skipIf(windowsHost)("runs an explicit native updater outside PATH", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-native-update");
      const nativePath = NodePath.join(
        tempDir,
        "with spaces",
        ".local",
        "bin",
        "native-package-tool",
      );
      NodeFS.mkdirSync(NodePath.dirname(nativePath), { recursive: true });
      NodeFS.writeFileSync(nativePath, "#!/bin/sh\nprintf '%s' \"$1\"\n");
      NodeFS.chmodSync(nativePath, 0o755);

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
        nativePackageToolUpdate,
        { binaryPath: nativePath, env: { PATH: "" } },
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

      expect(capabilities.update?.executable).toBe(nativePath);
      const result = NodeChildProcess.spawnSync(
        capabilities.update!.executable,
        capabilities.update!.args,
        { env: { PATH: "" }, encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("update");
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "prefers npm ownership over the Node keg the package lives under",
    () =>
      Effect.gen(function* () {
        // `brew install node` keeps npm globals inside the node keg.
        const tempDir = yield* makeTempDir("t3-homebrew-node-capabilities");
        const keg = NodePath.join(tempDir, "Cellar", "node", "22.1.0");
        const target = NodePath.join(
          keg,
          "lib",
          "node_modules",
          "@example",
          "package-tool",
          "bin",
          "package-tool.js",
        );
        writeExecutable(target);
        const link = NodePath.join(tempDir, "bin", "package-tool");
        NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true });
        NodeFS.symlinkSync(target, link);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: link,
            env: { PATH: "" },
          },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

        expect(capabilities.update).toMatchObject({
          executable: "npm",
          args: expect.arrayContaining(["--prefix", keg]),
          lockKey: `npm-global:${normalizeCommandPath(keg)}`,
        });
      }),
  );

  it("quotes copyable command words the shell would split", () => {
    const posix = makeProviderMaintenanceCapabilities({
      provider: driver("packageTool"),
      packageName: "@example/package-tool",
      updateExecutable: "npm",
      updateArgs: [
        "install",
        "-g",
        "--prefix",
        "/Users/Jane Doe/.npm-global",
        "@example/package-tool@latest",
      ],
      updateLockKey: "npm-global",
      platform: "darwin",
    });
    expect(posix.update?.command).toBe(
      "npm install -g --prefix '/Users/Jane Doe/.npm-global' @example/package-tool@latest",
    );
    const windows = makeProviderMaintenanceCapabilities({
      provider: driver("packageTool"),
      packageName: null,
      updateExecutable: "C:\\Program Files\\Tool\\tool.exe",
      updateArgs: ["update"],
      updateLockKey: "tool",
      platform: "win32",
    });
    expect(windows.update?.command).toBe("& 'C:\\Program Files\\Tool\\tool.exe' update");
  });

  it.effect.skipIf(windowsHost)("carries the native updater's environment into the action", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-native-env");
      const nativePath = NodePath.join(tempDir, ".local", "bin", "native-package-tool");
      writeExecutable(nativePath);
      const resolver = makePackageManagedProviderMaintenanceResolver({
        provider: driver("nativePackageTool"),
        npmPackageName: "@example/native-package-tool",
        nativeUpdate: {
          args: ["update"],
          isCommandPath: isNativeTestCommandPath("/.local/bin/native-package-tool"),
          env: { TOOL_HOME: tempDir },
        },
      });

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(resolver, {
        binaryPath: nativePath,
        env: { PATH: "" },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

      expect(capabilities.update?.env).toEqual({ TOOL_HOME: tempDir });
    }),
  );

  it("recognizes Homebrew kegs and casks from the real executable path", () => {
    expect(
      homebrewOwnershipFromCommandPath("/opt/homebrew/Cellar/claude-code@latest/2.1.0/bin/claude"),
    ).toEqual({ kind: "formula", name: "claude-code@latest", prefix: "/opt/homebrew" });
    expect(homebrewOwnershipFromCommandPath("/usr/local/Caskroom/codex/0.148.0/codex")).toEqual({
      kind: "cask",
      name: "codex",
      prefix: "/usr/local",
    });
    // A plain /usr/local/bin binary is not evidence of Homebrew (#8832).
    expect(homebrewOwnershipFromCommandPath("/usr/local/bin/codex")).toBeNull();
    expect(homebrewOwnershipFromCommandPath("/srv/Cellar/claude/1.0.0/bin/claude")).toMatchObject({
      prefix: "/srv",
    });
  });

  it.effect.skipIf(windowsHost)(
    "stays manual-only for an explicit binary path that does not exist",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-missing-native-capabilities");
        const missingPath = NodePath.join(tempDir, ".local", "bin", "native-package-tool");

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          nativePackageToolUpdate,
          { binaryPath: missingPath, env: { PATH: "" } },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

        expect(capabilities.update).toBeNull();
      }),
  );

  it.effect.each([
    {
      directory: "Caskroom",
      name: "package-tool",
      kind: "cask",
      version: "0.148.0,42",
      latestVersion: "0.148.0",
    },
    {
      directory: "Cellar",
      name: "package-tool",
      kind: "formula",
      version: "0.148.0",
      latestVersion: "0.148.0",
    },
    {
      directory: "Cellar",
      name: "package-tool@latest",
      kind: "formula",
      version: "0.148.0",
      latestVersion: "0.148.0",
    },
    {
      directory: "Caskroom",
      name: "versionless-package-tool",
      kind: "cask",
      version: "latest",
      latestVersion: null,
    },
  ] as const)(
    "upgrades the owning Homebrew $kind $name through an executable alias",
    (fixture) =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-homebrew-capabilities");
        const brewBinDir = NodePath.join(tempDir, "brew-bin");
        const brewPath = NodePath.join(brewBinDir, "brew");
        writeExecutable(brewPath);
        const ownedBinary = NodePath.join(
          tempDir,
          fixture.directory,
          fixture.name,
          fixture.latestVersion ?? "latest",
          "package-tool-0.148.0",
        );
        writeExecutable(ownedBinary);
        const link = NodePath.join(tempDir, "bin", "custom-package-tool");
        NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true });
        NodeFS.symlinkSync(ownedBinary, link);
        const spawned: Array<ReadonlyArray<string>> = [];

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: link,
            env: { PATH: brewBinDir },
          },
        ).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            stdoutSpawner((command, args) => {
              spawned.push([command, ...args]);
              return args[0] === "--prefix"
                ? `${tempDir}\n`
                : JSON.stringify(
                    fixture.kind === "cask"
                      ? { casks: [{ version: fixture.version }] }
                      : { formulae: [{ versions: { stable: fixture.version } }] },
                  );
            }),
          ),
        );

        expect(capabilities).toMatchObject({
          provider: driver("packageTool"),
          packageName: "@example/package-tool",
          update: {
            command:
              fixture.kind === "cask"
                ? `brew upgrade --cask ${fixture.name}`
                : `brew upgrade ${fixture.name}`,
            executable: brewPath,
            args:
              fixture.kind === "cask"
                ? ["upgrade", "--cask", fixture.name]
                : ["upgrade", fixture.name],
            lockKey: "homebrew",
          },
        });

        const enrich = (enableProviderUpdateChecks: boolean) =>
          enrichProviderSnapshotWithVersionAdvisory(
            { ...installedPackageToolProvider, version: "0.148.0" },
            capabilities,
            { enableProviderUpdateChecks },
          ).pipe(
            Effect.provide(ProviderLatestVersions.layer),
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make(() =>
                Effect.die("Homebrew version checks should not fall back to npm"),
              ),
            ),
          );

        expect((yield* enrich(false)).versionAdvisory).toMatchObject({
          status: "unknown",
          latestVersion: null,
        });
        expect(spawned).toEqual([[brewPath, "--prefix"]]);

        expect((yield* enrich(true)).versionAdvisory).toMatchObject({
          status: fixture.latestVersion === null ? "unknown" : "current",
          latestVersion: fixture.latestVersion,
          canUpdate: true,
          message: null,
        });
        expect(spawned).toEqual([
          [brewPath, "--prefix"],
          [brewPath, "info", "--json=v2", fixture.name],
        ]);
      }),
    { skip: !symlinksSupported },
  );

  it.effect("shares installer lookups only for the same executable and update target", () =>
    Effect.gen(function* () {
      let lookups = 0;
      const capabilities = (executable: string, args: ReadonlyArray<string>, version: string) =>
        makeProviderMaintenanceCapabilities({
          provider: driver("packageTool"),
          packageName: "@example/package-tool",
          updateExecutable: executable,
          updateArgs: args,
          updateLockKey: "homebrew",
          latestVersion: null,
          lookupLatestVersion: Effect.sync(() => {
            lookups += 1;
            return version;
          }),
        });

      const formula = capabilities("/opt/homebrew/bin/brew", ["upgrade", "package-tool"], "2.0.0");
      const cask = capabilities(
        "/opt/homebrew/bin/brew",
        ["upgrade", "--cask", "package-tool"],
        "3.0.0",
      );
      const otherBrew = capabilities("/usr/local/bin/brew", ["upgrade", "package-tool"], "4.0.0");

      expect(yield* resolveLatestProviderVersion(formula)).toBe("2.0.0");
      expect(yield* resolveLatestProviderVersion(cask)).toBe("3.0.0");
      expect(yield* resolveLatestProviderVersion(otherBrew)).toBe("4.0.0");
      const refreshed = capabilities(
        "/opt/homebrew/bin/brew",
        ["upgrade", "package-tool"],
        "5.0.0",
      );
      expect(yield* resolveLatestProviderVersion(refreshed)).toBe("2.0.0");
      expect(lookups).toBe(3);

      yield* invalidateLatestProviderVersion(refreshed);
      expect(yield* resolveLatestProviderVersion(refreshed)).toBe("5.0.0");
      expect(yield* resolveLatestProviderVersion(cask)).toBe("3.0.0");
      expect(yield* resolveLatestProviderVersion(otherBrew)).toBe("4.0.0");
      expect(lookups).toBe(4);
    }).pipe(
      Effect.provide(ProviderLatestVersions.layer),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Homebrew's latest should not come from npm")),
      ),
    ),
  );

  it.effect(
    "refreshes installer versions without letting an older lookup overwrite the result",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<string>();
        let lookups = 0;
        const capabilities = makeProviderMaintenanceCapabilities({
          provider: driver("packageTool"),
          packageName: "@example/package-tool",
          updateExecutable: "/opt/homebrew/bin/brew",
          updateArgs: ["upgrade", "package-tool"],
          updateLockKey: "homebrew",
          latestVersion: null,
          lookupLatestVersion: Effect.suspend(() =>
            ++lookups === 1
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.succeed("2.0.0"),
          ),
        });
        const pending = yield* resolveLatestProviderVersion(capabilities).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* invalidateLatestProviderVersion(capabilities);
        expect(yield* resolveLatestProviderVersion(capabilities)).toBe("2.0.0");

        yield* Deferred.succeed(release, "1.0.0");
        expect(yield* Fiber.join(pending)).toBe("1.0.0");
        expect(yield* resolveLatestProviderVersion(capabilities)).toBe("2.0.0");
        expect(lookups).toBe(2);
      }).pipe(
        Effect.provide(ProviderLatestVersions.layer),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Homebrew's latest should not come from npm")),
        ),
      ),
  );

  it.effect.skipIf(windowsHost)(
    "stays manual-only when the keg is not under the resolved brew's prefix",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-homebrew-foreign-prefix");
        const brewBinDir = NodePath.join(tempDir, "brew-bin");
        writeExecutable(NodePath.join(brewBinDir, "brew"));
        const kegBinary = NodePath.join(
          tempDir,
          "elsewhere",
          "Cellar",
          "package-tool",
          "1.0.0",
          "bin",
          "package-tool",
        );
        writeExecutable(kegBinary);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: kegBinary,
            env: { PATH: brewBinDir },
          },
        ).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            stdoutSpawner(() => "/opt/homebrew\n"),
          ),
        );

        expect(capabilities).toEqual({
          ...manualPackageTool,
          installPath: NodeFS.realpathSync(kegBinary),
        });
      }),
  );

  it("reads the stable formula version from brew info", () => {
    const info = JSON.stringify({ formulae: [{ versions: { stable: "2.1.5" } }] });
    const formula = { kind: "formula", name: "claude-code", prefix: "/opt/homebrew" } as const;
    expect(parseHomebrewLatestVersion(info, formula)).toBe("2.1.5");
    expect(parseHomebrewLatestVersion("not json", formula)).toBeNull();
  });

  it("treats Homebrew's latest cask version as unknown", () => {
    const info = JSON.stringify({ casks: [{ version: "latest" }] });
    const cask = { kind: "cask", name: "package-tool", prefix: "/opt/homebrew" } as const;
    expect(parseHomebrewLatestVersion(info, cask)).toBeNull();
  });

  it.effect.skipIf(windowsHost)(
    "disables one-click updates for explicit custom binary paths it cannot safely map",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-custom-capabilities");
        const customPath = NodePath.join(tempDir, "tools", "package-tool");
        writeExecutable(customPath);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: customPath,
            env: { PATH: "" },
          },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

        expect(capabilities).toEqual({
          ...manualPackageTool,
          installPath: NodeFS.realpathSync(customPath),
        });
      }),
  );

  it.effect.skipIf(windowsHost)(
    "falls back to the provider's own updater when no installer is proven",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-self-update-fallback");
        const customPath = NodePath.join(tempDir, "tools", "package-tool");
        writeExecutable(customPath);
        const selfUpdating = makePackageManagedProviderMaintenanceResolver({
          provider: driver("packageTool"),
          npmPackageName: "@example/package-tool",
          nativeUpdate: { args: ["update", "--self"] },
        });

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(selfUpdating, {
          binaryPath: customPath,
          env: { PATH: "" },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));
        expect(capabilities.update).toMatchObject({
          executable: customPath,
          args: ["update", "--self"],
          lockKey: "packageTool-native",
        });

        const misePath = NodePath.join(tempDir, "mise", "installs", "package-tool", "1.0.0", "bin");
        writeExecutable(NodePath.join(misePath, "package-tool"));
        const mise = yield* resolveProviderMaintenanceCapabilitiesEffect(selfUpdating, {
          binaryPath: NodePath.join(misePath, "package-tool"),
          env: { PATH: "" },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));
        expect(mise.update).toBeNull();
      }),
  );

  it.effect.skipIf(!symlinksSupported)("updates Yarn global installs with yarn", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-yarn-capabilities");
      const link = linkIntoPackage(tempDir, "package-tool", [
        ".config",
        "yarn",
        "global",
        "node_modules",
        "@example",
        "package-tool",
      ]);

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: link,
        env: { PATH: "" },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

      expect(capabilities.update).toMatchObject({
        command: "yarn global add @example/package-tool@latest",
        lockKey: "yarn-global",
      });
      expect(makeTargetedProviderUpdateAction(capabilities, "2.0.0")?.args).toEqual([
        "global",
        "add",
        "@example/package-tool@2.0.0",
      ]);
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "updates Volta installs only when Volta has the package",
    () =>
      Effect.gen(function* () {
        const voltaHome = NodePath.join(yield* makeTempDir("t3-volta-capabilities"), ".volta");
        const shim = NodePath.join(voltaHome, "bin", "volta-shim");
        writeExecutable(shim);
        const link = NodePath.join(voltaHome, "bin", "package-tool");
        NodeFS.symlinkSync(shim, link);
        const resolve = resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
          binaryPath: link,
          env: { PATH: "" },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

        expect((yield* resolve).update).toBeNull();
        NodeFS.mkdirSync(
          NodePath.join(voltaHome, "tools", "image", "packages", "@example", "package-tool"),
          { recursive: true },
        );
        expect((yield* resolve).update).toMatchObject({
          command: "volta install @example/package-tool@latest",
          lockKey: "volta",
        });
      }),
  );

  it.effect.skipIf(windowsHost)("upgrades with the keg's own brew when brew is not on PATH", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-homebrew-keg-brew");
      const brewPath = NodePath.join(tempDir, "bin", "brew");
      writeExecutable(brewPath);
      const kegBinary = NodePath.join(tempDir, "Cellar", "package-tool", "1.0.0", "bin", "tool");
      writeExecutable(kegBinary);

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: kegBinary,
        env: { PATH: "" },
      }).pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          stdoutSpawner((_command, args) => (args[0] === "--prefix" ? `${tempDir}\n` : "{}")),
        ),
      );

      expect(capabilities.update).toMatchObject({
        executable: brewPath,
        args: ["upgrade", "package-tool"],
        lockKey: "homebrew",
      });
    }),
  );

  it.effect("caches resolution until a fresh read is requested", () =>
    Effect.gen(function* () {
      let resolutions = 0;
      const resolve = yield* makeCachedProviderMaintenanceResolution(
        Effect.sync(() => {
          resolutions += 1;
          return manualPackageTool;
        }),
      );
      yield* resolve();
      yield* resolve();
      expect(resolutions).toBe(1);
      yield* resolve({ fresh: true });
      yield* resolve();
      expect(resolutions).toBe(2);
    }),
  );

  it.effect("starts a fresh read instead of joining the resolution already running", () =>
    Effect.gen(function* () {
      const releaseStale = yield* Deferred.make<void>();
      let resolutions = 0;
      const resolve = yield* makeCachedProviderMaintenanceResolution(
        Effect.suspend(() => {
          resolutions += 1;
          return resolutions === 1
            ? Deferred.await(releaseStale).pipe(Effect.as(manualPackageTool))
            : Effect.succeed(manualPackageTool);
        }),
      );

      const advisory = yield* Effect.forkChild(resolve(), { startImmediately: true });
      const fresh = yield* Effect.forkChild(resolve({ fresh: true }), { startImmediately: true });
      expect(resolutions).toBe(2);
      expect(fresh.pollUnsafe()).toBeDefined();
      yield* Deferred.succeed(releaseStale, undefined);
      expect(yield* Fiber.join(fresh)).toEqual(manualPackageTool);
      yield* Fiber.join(advisory);
    }),
  );

  it.effect("resolves again after the first read is interrupted", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      let resolutions = 0;
      const resolve = yield* makeCachedProviderMaintenanceResolution(
        Effect.suspend(() => {
          resolutions += 1;
          return resolutions === 1
            ? Effect.never
            : Deferred.await(release).pipe(Effect.as(manualPackageTool));
        }),
      );

      const first = yield* Effect.forkChild(resolve(), { startImmediately: true });
      yield* Fiber.interrupt(first);

      const owner = yield* Effect.forkChild(resolve(), { startImmediately: true });
      const waiter = yield* Effect.forkChild(resolve(), { startImmediately: true });
      yield* Fiber.interrupt(owner);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(waiter)).toEqual(manualPackageTool);
      expect(yield* resolve()).toEqual(manualPackageTool);
      expect(resolutions).toBe(2);
    }),
  );
});

// The Windows installer exposes a junction; ownership is identified by realpath.
it.each([
  ["/opt/tools/codex", "/home/developer/.codex/packages/standalone/current/bin/codex"],
  [
    "C:\\Users\\Developer\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
    "C:\\Users\\Developer\\.codex\\packages\\standalone\\current\\bin\\codex.exe",
  ],
])("does not offer npm updates for standalone Codex at %s", (visiblePath, realPath) =>
  Effect.gen(function* () {
    const capabilities = yield* resolvePackageManagedProviderMaintenance(
      {
        provider: driver("codex"),
        npmPackageName: "@openai/codex",
        nativeUpdate: null,
      },
      {
        binaryPath: "codex",
        resolvedCommandPath: visiblePath,
        realCommandPath: realPath,
        env: {},
        platform: "linux",
      },
    );
    expect(capabilities.update).toBeNull();
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise),
);
it("pins only owned package-manager installs and preserves their execution context", () => {
  const capabilities = makeProviderMaintenanceCapabilities({
    provider: driver("codex"),
    packageName: "@openai/codex",
    updateExecutable: "npm",
    updateLockKey: "npm-global:/opt/node",
    updateArgs: [
      "install",
      "-g",
      "--prefix",
      "/opt/node",
      "--allow-scripts=@openai/codex",
      "@openai/codex@latest",
    ],
    env: { PATH: "/opt/node/bin" },
  });
  const pinned = makeTargetedProviderUpdateAction(capabilities, "2.0.0");
  expect(pinned).toMatchObject({
    executable: "npm",
    lockKey: capabilities.update?.lockKey,
    env: capabilities.update?.env,
    args: [
      "install",
      "-g",
      "--prefix",
      "/opt/node",
      "--allow-scripts=@openai/codex",
      "@openai/codex@2.0.0",
    ],
  });
  expect(pinned?.command).toContain("@openai/codex@2.0.0");
  for (const lockKey of ["codex-native", "homebrew", "manual"]) {
    expect(
      makeTargetedProviderUpdateAction(
        { ...capabilities, update: { ...capabilities.update!, lockKey } },
        "2.0.0",
      ),
    ).toBeNull();
  }
  expect(makeTargetedProviderUpdateAction(capabilities, "2.0.0; rm -rf /")).toBeNull();
});

it("pins a proven native install through its own installer, excluding Windows by default", () =>
  Effect.gen(function* () {
    const definition = {
      provider: driver("nativePackageTool"),
      npmPackageName: "@example/native-package-tool",
      nativeUpdate: {
        args: ["update"],
        isCommandPath: isNativeTestCommandPath("/.local/bin/native-package-tool"),
        env: { TOOL_HOME: "/home/developer/.tool" },
        pinned: (version: string, context: { readonly resolvedCommandPath: string }) => ({
          executable: context.resolvedCommandPath,
          args: ["install", version],
          env: { TOOL_HOME: "/home/developer/.tool" },
        }),
      },
    };
    const visible = "/home/developer/.local/bin/native-package-tool";
    const resolve = (platform: NodeJS.Platform, commandPath = visible) =>
      resolvePackageManagedProviderMaintenance(definition, {
        binaryPath: "native-package-tool",
        resolvedCommandPath: commandPath,
        realCommandPath: commandPath,
        env: {},
        platform,
      });

    const native = yield* resolve("darwin");
    // A manual update still moves to the latest release.
    expect(native.update).toMatchObject({ executable: visible, args: ["update"] });
    expect(makeTargetedProviderUpdateAction(native, "2.0.0")).toEqual({
      executable: visible,
      args: ["install", "2.0.0"],
      env: { TOOL_HOME: "/home/developer/.tool" },
      command: `${visible} install 2.0.0`,
      lockKey: "nativePackageTool-native",
    });
    expect(makeTargetedProviderUpdateAction(native, "2.0.0; rm -rf /")).toBeNull();
    expect(
      createProviderVersionAdvisory({
        driver: driver("nativePackageTool"),
        currentVersion: "1.0.0",
        maintenanceCapabilities: native,
      }).canInstallVersion,
    ).toBe(true);

    // A pinnable install reports whether its own updater is on when it can tell.
    expect(native.selfUpdaterActive).toBeUndefined();
    const detected = yield* resolvePackageManagedProviderMaintenance(
      {
        ...definition,
        nativeUpdate: { ...definition.nativeUpdate, selfUpdaterActive: () => Effect.succeed(true) },
      },
      {
        binaryPath: "native-package-tool",
        resolvedCommandPath: visible,
        realCommandPath: visible,
        env: {},
        platform: "darwin",
      },
    );
    expect(detected.selfUpdaterActive).toBe(true);

    // Native installers must opt into Windows pinning at the provider boundary.
    const windows = yield* resolve("win32", "C:/Users/Developer/.local/bin/native-package-tool");
    expect(windows.update?.args).toEqual(["update"]);
    expect(makeTargetedProviderUpdateAction(windows, "2.0.0")).toBeNull();

    // An unproven path falls back to the native updater, which detects its own
    // installer; pinning it would install a second, native copy.
    const unproven = yield* resolve("linux", "/opt/tools/native-package-tool");
    expect(unproven.update?.args).toEqual(["update"]);
    expect(makeTargetedProviderUpdateAction(unproven, "2.0.0")).toBeNull();
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise));

it.effect("does not expose a POSIX-only native installer or its updater controls on Windows", () =>
  Effect.gen(function* () {
    const binaryPath = "C:\\Users\\Developer\\.codex\\packages\\standalone\\bin\\codex.exe";
    const capabilities = yield* resolvePackageManagedProviderMaintenance(
      {
        provider: driver("codex"),
        npmPackageName: "@openai/codex",
        nativeUpdate: {
          args: ["update"],
          isCommandPath: isNativeTestCommandPath("/packages/standalone/"),
          pinned: (version) => ({ executable: "/bin/sh", args: ["install.sh", version] }),
          selfUpdaterActive: () =>
            Effect.die("An unsupported installer must not read updater state"),
          selfUpdater: () => {
            throw new Error("An unsupported installer must not expose updater controls");
          },
        },
      },
      {
        binaryPath,
        resolvedCommandPath: binaryPath,
        realCommandPath: binaryPath,
        env: {},
        platform: "win32",
      },
    );
    expect(capabilities.update?.args).toEqual(["update"]);
    expect(makeTargetedProviderUpdateAction(capabilities, "2.0.0")).toBeNull();
    expect(capabilities.selfUpdaterActive).toBeUndefined();
    expect(capabilities.selfUpdater).toBeUndefined();
    expect(
      createProviderVersionAdvisory({
        driver: driver("codex"),
        currentVersion: "1.0.0",
        maintenanceCapabilities: capabilities,
      }).canInstallVersion,
    ).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);
