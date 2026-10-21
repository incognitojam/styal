import { describe, it, assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import { ServerProviderUpdateError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";

import * as ProviderInstallGate from "./ProviderInstallGate.ts";
import * as ProviderInstallLock from "./ProviderInstallLock.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ServerSettings from "../serverSettings.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import { makeClaudeMaintenance } from "./Drivers/ClaudeDriver.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceResolverServices,
} from "@t3tools/provider-core/server/maintenanceResolver";
const isServerProviderUpdateError = Schema.is(ServerProviderUpdateError);

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const NATIVE_CLI_DRIVER = ProviderDriverKind.make("nativeCli");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const NATIVE_CLI_INSTANCE_ID = ProviderInstanceId.make("nativeCli");
const OPENCODE_INSTANCE_ID = ProviderInstanceId.make("opencode");
const encoder = new TextEncoder();

// Pin a non-win32 platform so `resolveSpawnCommand` is a no-op and the raw
// `{ command, args }` assertions below hold deterministically on any host
// (including Windows). Windows-specific resolution is covered by the dedicated
// win32 case at the end of this suite.
const layerNonWindowsPlatform = Layer.succeed(HostProcess.Platform, "linux");

function lifecycleFor(provider: ProviderDriverKind): ProviderMaintenanceCapabilities {
  if (provider === NATIVE_CLI_DRIVER) {
    return makeProviderMaintenanceCapabilities({
      provider,
      packageName: null,
      updateExecutable: "native-agent",
      updateArgs: ["update"],
      updateLockKey: "native-agent",
    });
  }
  return makeProviderMaintenanceCapabilities({
    provider,
    packageName: provider === OPENCODE_DRIVER ? "opencode-ai" : "@openai/codex",
    updateExecutable: "npm",
    updateArgs:
      provider === OPENCODE_DRIVER
        ? ["install", "-g", "opencode-ai@latest"]
        : ["install", "-g", "@openai/codex@latest"],
    updateLockKey: "npm-global",
  });
}

const baseProvider: ServerProvider = {
  instanceId: CODEX_INSTANCE_ID,
  driver: CODEX_DRIVER,
  enabled: true,
  installed: true,
  version: "0.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const baseNativeCliProvider: ServerProvider = {
  ...baseProvider,
  instanceId: NATIVE_CLI_INSTANCE_ID,
  driver: NATIVE_CLI_DRIVER,
};

const baseOpenCodeProvider: ServerProvider = {
  ...baseProvider,
  instanceId: OPENCODE_INSTANCE_ID,
  driver: OPENCODE_DRIVER,
};

const layerLatestVersionHttpClient = (version: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ version }, { headers: { "content-type": "application/json" } }),
        ),
      ),
    ),
  );

function mockHandle(result: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: result.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function layerMockSpawner(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
    options: {
      readonly env?: NodeJS.ProcessEnv | undefined;
      readonly shell?: boolean | string | undefined;
    },
  ) => {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly code?: number;
    readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly options: {
          readonly env?: NodeJS.ProcessEnv | undefined;
          readonly shell?: boolean | string | undefined;
        };
      };
      return Effect.succeed(
        mockHandle(handler(childProcess.command, childProcess.args, childProcess.options)),
      );
    }),
  );
}

function makeRegistry(
  initialProviders: ServerProvider | ReadonlyArray<ServerProvider> = baseProvider,
) {
  return Effect.gen(function* () {
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      Array.isArray(initialProviders) ? initialProviders : [initialProviders],
    );
    const updateStatesRef = yield* Ref.make<ReadonlyArray<ServerProviderUpdateState>>([]);

    const setProviderMaintenanceActionState = Effect.fn(
      "providerMaintenanceRunner.test.setProviderMaintenanceActionState",
    )(function* (input: {
      readonly instanceId: ProviderInstanceId;
      readonly action: "update";
      readonly state: ServerProviderUpdateState | null;
    }) {
      const updateState = input.state;
      if (updateState) {
        yield* Ref.update(updateStatesRef, (states) => [...states, updateState]);
      }
      return yield* Ref.updateAndGet(providersRef, (providers) =>
        providers.map((candidate) => {
          if (candidate.instanceId !== input.instanceId) {
            return candidate;
          }
          if (!updateState) {
            const { updateState: _updateState, ...providerWithoutUpdateState } = candidate;
            return providerWithoutUpdateState;
          }
          return {
            ...candidate,
            updateState,
          };
        }),
      );
    });

    const registry: ProviderRegistry.ProviderRegistry["Service"] = {
      getProviders: Ref.get(providersRef),
      refresh: () => Ref.get(providersRef),
      refreshInstance: () => Ref.get(providersRef),
      refreshAfterUpdate: () => Ref.get(providersRef),
      refreshWorkspaceSnapshot: () => Ref.get(providersRef),
      getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
        Effect.succeed(lifecycleFor(provider)),
      setProviderMaintenanceActionState,
      streamChanges: Stream.empty,
    };

    return {
      registry,
      providersRef,
      updateStatesRef,
    };
  });
}

// The real gate over a lock no other process holds, unless a test says otherwise.
const layerInstallGate = (lock: Partial<ProviderInstallLock.ProviderInstallLock["Service"]> = {}) =>
  Layer.effect(ProviderInstallGate.ProviderInstallGate, ProviderInstallGate.make).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstallLock.ProviderInstallLock)({
          tryRun: (_lockKey, run) => run(() => Effect.void).pipe(Effect.asSome),
          ...lock,
        }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
      ),
    ),
  );

const makeTestRunner = (
  registry: ProviderRegistry.ProviderRegistry["Service"],
  manifest: ModelManifest.ModelManifestData = {
    version: 1,
    currentModels: {},
    compatibility: [CODEX_DRIVER, OPENCODE_DRIVER].map((driver) => ({
      driver,
      t3CodeRange: ">=0.0.42",
      ranges: [],
    })),
  },
  lock: Partial<ProviderInstallLock.ProviderInstallLock["Service"]> = {},
  events: Array<{ readonly event: string; readonly properties: unknown }> = [],
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
) =>
  Effect.service(ProviderMaintenanceRunner.ProviderMaintenanceRunner).pipe(
    Effect.provide(
      ProviderMaintenanceRunner.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ProviderRegistry.ProviderRegistry, registry),
            Layer.succeed(ModelManifest.ModelManifest, {
              current: Effect.succeed(manifest),
              refresh: Effect.succeed(manifest),
              forceRefresh: Effect.succeed(manifest),
              refreshInBackground: Effect.void,
              remote: Effect.succeed(null),
            }),
            ProviderLatestVersions.layer,
            layerInstallGate(lock),
            ServerSettings.layerTest(settings),
            Layer.succeed(
              AnalyticsService.AnalyticsService,
              AnalyticsService.AnalyticsService.of({
                recordOwners: () => Effect.void,
                record: (event, properties) =>
                  Effect.sync(() => {
                    events.push({ event, properties });
                  }),
                flush: Effect.void,
              }),
            ),
          ),
        ),
      ),
    ),
  );

describe("providerMaintenanceRunner", () => {
  it.effect("runs the allowlisted provider update command and records success", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { registry, updateStatesRef } = yield* makeRegistry(baseNativeCliProvider);
      const updater = yield* makeTestRunner(registry);

      const result = yield* updater.updateProvider(NATIVE_CLI_DRIVER);
      assert.deepStrictEqual(calls, [
        {
          command: "native-agent",
          args: ["update"],
        },
      ]);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.deepStrictEqual(
        (yield* Ref.get(updateStatesRef)).map((state) => [state.status, state.message]),
        [
          ["queued", "Waiting for another provider update to finish."],
          ["running", "Checking for the latest version"],
          ["running", "Running native-agent update"],
          ["running", "Verifying the installed version"],
          ["succeeded", "Provider updated."],
        ],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("reports unchanged when the updater exits 0 but the provider no longer starts", () => {
    return Effect.gen(function* () {
      const { registry, providersRef } = yield* makeRegistry(baseProvider);
      const probeMessage =
        "Codex app-server provider probe failed: Codex App Server process exited with code 1: Error: Missing optional dependency @openai/codex-linux-x64.";
      const updater = yield* makeTestRunner({
        ...registry,
        refreshAfterUpdate: () =>
          Ref.updateAndGet(providersRef, (providers) =>
            providers.map((provider) => ({
              ...provider,
              installed: true,
              version: null,
              status: "error" as const,
              message: probeMessage,
            })),
          ),
      });

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      assert.strictEqual(result.providers[0]?.updateState?.status, "unchanged");
      assert.strictEqual(
        result.providers[0]?.updateState?.message,
        `Update command completed, but the provider reports an error: ${probeMessage}`,
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner(() => ({ stdout: "updated" })),
        ),
      ),
    );
  });

  it.effect(
    "keeps a successful update when the binary is present but its version is unreadable",
    () => {
      return Effect.gen(function* () {
        const { registry, providersRef } = yield* makeRegistry(baseNativeCliProvider);
        const updater = yield* makeTestRunner({
          ...registry,
          refreshAfterUpdate: () =>
            Ref.updateAndGet(providersRef, (providers) =>
              providers.map((provider) => ({ ...provider, installed: true, version: null })),
            ),
        });

        const result = yield* updater.updateProvider(NATIVE_CLI_DRIVER);
        assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerNonWindowsPlatform,
            layerLatestVersionHttpClient("0.0.0"),
            layerMockSpawner(() => ({ stdout: "updated" })),
          ),
        ),
      );
    },
  );

  it.effect("spawns the updater with the environment its capabilities declare", () => {
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
          Effect.succeed({
            ...lifecycleFor(provider),
            update: {
              command: "codex update",
              executable: "/work/codex-home/packages/standalone/bin/codex",
              args: ["update"],
              lockKey: "codex-native",
              env: { CODEX_HOME: "/work/codex-home" },
            },
          }),
      });

      yield* updater.updateProvider(CODEX_DRIVER);
      assert.deepStrictEqual(seen, [{ CODEX_HOME: "/work/codex-home" }]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner((_command, _args, options) => {
            seen.push(options.env);
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("re-resolves ownership before running and executes the fresh command", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const fresh: Array<boolean> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider, options) => {
          fresh.push(options?.fresh === true);
          return Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider,
              packageName: "@openai/codex",
              updateExecutable: options?.fresh ? "/opt/homebrew/bin/brew" : "brew",
              updateArgs: ["upgrade", "--cask", "codex"],
              updateLockKey: "homebrew",
            }),
          );
        },
      });

      yield* updater.updateProvider(CODEX_DRIVER);
      assert.deepStrictEqual(fresh, [false, true, true]);
      assert.deepStrictEqual(calls, [
        { command: "/opt/homebrew/bin/brew", args: ["upgrade", "--cask", "codex"] },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it("splits installer output into clean status lines", () => {
    assert.deepStrictEqual(ProviderMaintenanceRunner.splitOutputLines("Down", "loading\r\n 5"), {
      lines: ["Downloading"],
      partialLine: " 5",
    });
    assert.strictEqual(
      ProviderMaintenanceRunner.toProgressLine("\u001b[1m==>\u001b[0m  Pouring"),
      "==> Pouring",
    );
    assert.strictEqual(ProviderMaintenanceRunner.toProgressLine(" \t "), null);
    assert.strictEqual(
      ProviderMaintenanceRunner.splitOutputLines("x".repeat(5_000), "y").partialLine.length,
      4_096,
    );
    assert.strictEqual(ProviderMaintenanceRunner.toProgressLine("x".repeat(300))?.length, 200);
  });

  it.effect("aborts without running when the installation changed since the advisory", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { registry, updateStatesRef } = yield* makeRegistry(baseProvider);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider, options) =>
          Effect.succeed(
            options?.fresh
              ? makeProviderMaintenanceCapabilities({
                  provider,
                  packageName: "@openai/codex",
                  updateExecutable: null,
                  updateArgs: [],
                  updateLockKey: null,
                })
              : lifecycleFor(provider),
          ),
      });

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(result.providers[0]?.updateState?.status, "failed");
      assert.strictEqual(
        result.providers[0]?.updateState?.message,
        "Provider installation changed. Refresh and try again.",
      );
      assert.deepStrictEqual(
        (yield* Ref.get(updateStatesRef)).map((state) => state.status),
        ["queued", "running", "failed"],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner((command) => {
            calls.push(command);
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("does not report verified success when selected-instance discovery fails", () =>
    Effect.gen(function* () {
      const { registry, providersRef } = yield* makeRegistry(baseNativeCliProvider);
      const updater = yield* makeTestRunner({
        ...registry,
        // The registry marks an instance whose refresh failed and leaves it
        // out of the refreshed snapshots.
        refreshAfterUpdate: () =>
          Ref.update(providersRef, (providers) =>
            providers.map((provider) => ({
              ...provider,
              status: "error",
              message: "Provider refresh failed after update.",
            })),
          ).pipe(Effect.as([])),
      });
      const result = yield* updater.updateProvider(NATIVE_CLI_DRIVER);
      assert.strictEqual(result.providers[0]?.status, "error");
      assert.strictEqual(result.providers[0]?.updateState?.status, "unchanged");
      assert.match(result.providers[0]?.updateState?.message ?? "", /could not verify/);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner(() => ({ stdout: "updated" })),
        ),
      ),
    ),
  );

  it.effect("records command failure output in provider update state", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistry();
      const updater = yield* makeTestRunner(registry);

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      const updateState = result.providers[0]?.updateState;

      assert.strictEqual(updateState?.status, "failed");
      assert.strictEqual(updateState?.message, "Update command exited with code 1.");
      assert.include(updateState?.output ?? "", "permission denied");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner(() => ({ stderr: "permission denied", code: 1 })),
        ),
      ),
    ),
  );

  it.effect(
    "marks successful commands as unchanged when the refreshed provider is still outdated",
    () =>
      Effect.gen(function* () {
        const { registry } = yield* makeRegistry({
          ...baseProvider,
          installed: true,
          version: "0.1.0",
        });
        const updater = yield* makeTestRunner(registry);

        const result = yield* updater.updateProvider(CODEX_DRIVER);

        assert.strictEqual(result.providers[0]?.updateState?.status, "unchanged");
        assert.include(result.providers[0]?.updateState?.message ?? "", "still detects");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerNonWindowsPlatform,
            layerLatestVersionHttpClient("9.9.9"),
            layerMockSpawner(() => ({ stdout: "updated" })),
          ),
        ),
      ),
  );

  it.effect("prevents concurrent updates for the same provider", () => {
    const startedLatch: { resolve: () => void } = { resolve: () => {} };
    const releaseLatch: { resolve: () => void } = { resolve: () => {} };
    const started = new Promise<void>((resolve) => {
      startedLatch.resolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLatch.resolve = resolve;
    });
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry();
      const updater = yield* makeTestRunner(registry);

      const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
      yield* Effect.promise(() => started);

      const second = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.exit);
      assert.strictEqual(Exit.isFailure(second), true);
      if (Exit.isFailure(second)) {
        const error = Cause.squash(second.cause);
        assert.strictEqual(isServerProviderUpdateError(error), true);
        if (isServerProviderUpdateError(error)) {
          assert.include(error.reason, "already running");
        }
      }

      releaseLatch.resolve();
      yield* Fiber.join(first);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner(() => {
            startedLatch.resolve();
            return {
              stdout: "updated",
              exitCode: Effect.promise(() => release).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
            };
          }),
        ),
      ),
    );
  });

  it.effect(
    "releases the running-provider marker when interrupted after queuing but before the lock run starts",
    () =>
      Effect.gen(function* () {
        const { registry } = yield* makeRegistry(baseProvider);
        let blockQueuedState = true;
        const queuedStateWrittenLatch: { resolve: () => void } = { resolve: () => {} };
        const releaseQueuedStateLatch: { resolve: () => void } = { resolve: () => {} };
        const queuedStateWritten = new Promise<void>((resolve) => {
          queuedStateWrittenLatch.resolve = resolve;
        });
        const releaseQueuedState = new Promise<void>((resolve) => {
          releaseQueuedStateLatch.resolve = resolve;
        });

        const updater = yield* makeTestRunner({
          ...registry,
          setProviderMaintenanceActionState: Effect.fn(
            "providerMaintenanceRunner.test.blockQueuedState",
          )(function* (input) {
            const providers = yield* registry.setProviderMaintenanceActionState(input);
            if (input.state?.status === "queued" && blockQueuedState) {
              queuedStateWrittenLatch.resolve();
              yield* Effect.promise(() => releaseQueuedState);
            }
            return providers;
          }),
        });

        const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
        yield* Effect.promise(() => queuedStateWritten);
        blockQueuedState = false;

        yield* Fiber.interrupt(first);
        releaseQueuedStateLatch.resolve();

        const second = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.exit);
        assert.strictEqual(Exit.isSuccess(second), true);
        if (Exit.isSuccess(second)) {
          assert.strictEqual(second.value.providers[0]?.updateState?.status, "succeeded");
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerNonWindowsPlatform,
            layerLatestVersionHttpClient("0.0.0"),
            layerMockSpawner(() => ({ stdout: "updated" })),
          ),
        ),
      ),
  );

  it.effect("resolves npm to a .cmd shim and routes through the shell on win32", () => {
    const captured: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly shell: boolean | string | undefined;
    }> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider);
      const runner = yield* makeTestRunner(registry);

      const result = yield* runner.updateProvider(CODEX_DRIVER);

      assert.strictEqual(captured.length, 1);
      const call = captured[0];
      assert.ok(call, "expected the spawner to be invoked once");
      assert.strictEqual(
        call.command,
        '^"C:\\fake\\npm\\npm.cmd^" ^"install^" ^"-g^" ^"@openai/codex@latest^"',
      );
      assert.deepEqual(call.args, []);
      assert.strictEqual(call.shell, true);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Environment, {
            PATH: "C:\\fake\\npm",
            PATHEXT: ".COM;.EXE;.BAT;.CMD",
          }),
          Layer.succeed(SpawnExecutableResolution, (command) =>
            command === "npm" ? "C:\\fake\\npm\\npm.cmd" : undefined,
          ),
          layerLatestVersionHttpClient("0.0.0"),
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              const childProcess = command as unknown as {
                readonly command: string;
                readonly args: ReadonlyArray<string>;
                readonly options: { readonly shell?: boolean | string | undefined };
              };
              captured.push({
                command: childProcess.command,
                args: childProcess.args,
                shell: childProcess.options.shell,
              });
              return Effect.succeed(mockHandle({ stdout: "updated" }));
            }),
          ),
        ),
      ),
    );
  });
});

it.effect.each([
  {
    mode: "default",
    version: "1.14.19",
    installation: { installedVersion: "1.14.20" },
    status: "succeeded",
  },
  {
    mode: "targeted",
    version: "1.14.19",
    installation: { installedVersion: "1.14.20" },
    status: "succeeded",
  },
  {
    mode: "unknown",
    version: "1.14.20",
    installation: { installedVersion: null },
    status: "unchanged",
  },
  { mode: "legacy", version: "1.14.20", installation: {}, status: "succeeded" },
] as const)(
  "verifies the $mode OpenCode update using the refreshed installation",
  ({ mode, version, installation, status }) => {
    const calls: string[] = [];
    const capabilities = lifecycleFor(OPENCODE_DRIVER);
    const pinnedCapabilities = {
      ...capabilities,
      update: { ...capabilities.update!, lockKey: "npm-global:/fixture" },
    };
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: {},
      compatibility: [
        {
          driver: OPENCODE_DRIVER,
          t3CodeRange: ">=0.0.42",
          recommendedVersion: "1.14.20",
          ranges: [{ range: "=1.14.20", status: "supported" }],
        },
      ],
    };
    return Effect.gen(function* () {
      const { registry, providersRef } = yield* makeRegistry({ ...baseOpenCodeProvider, version });
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const updater = yield* makeTestRunner(
        {
          ...registry,
          getProviderMaintenanceCapabilitiesForInstance: () => Effect.succeed(pinnedCapabilities),
          refreshAfterUpdate: () =>
            Effect.gen(function* () {
              assert.strictEqual(calls.length, 1);
              const refreshed = yield* enrichProviderSnapshotWithVersionAdvisory(
                { ...baseOpenCodeProvider, version, ...installation },
                pinnedCapabilities,
              ).pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.provideService(
                  ProviderLatestVersions.ProviderLatestVersions,
                  latestVersions,
                ),
              );
              return yield* Ref.updateAndGet(providersRef, (providers) =>
                providers.map((provider) => ({ ...provider, ...refreshed })),
              );
            }),
        },
        manifest,
      );

      const result = yield* updater.updateProvider({
        provider: OPENCODE_DRIVER,
        ...(mode === "default" ? {} : { targetVersion: "1.14.20" }),
      });

      assert.deepStrictEqual(calls, [
        `npm install -g opencode-ai@${mode === "default" ? "latest" : "1.14.20"}`,
      ]);
      const provider = result.providers[0];
      assert.ok(provider);
      assert.strictEqual(provider.updateState?.status, status);
      assert.strictEqual(provider.version, version);
      assert.strictEqual("installedVersion" in provider, mode !== "legacy");
      assert.strictEqual(
        provider.versionAdvisory?.status,
        mode === "unknown" ? "unknown" : "current",
      );
      assert.strictEqual(
        provider.versionAdvisory?.currentVersion,
        mode === "unknown" ? null : "1.14.20",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          ProviderLatestVersions.layer,
          layerLatestVersionHttpClient("1.14.20"),
          layerMockSpawner((command, args) => {
            calls.push([command, ...args].join(" "));
            return { stdout: "installed" };
          }),
        ),
      ),
    );
  },
);

it.effect(
  "uses fresh installer versions for post-update verification and compatibility checks",
  () => {
    const calls: string[] = [];
    let latest = "1.0.0";
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: {},
      compatibility: [
        {
          driver: "codex",
          t3CodeRange: ">=0.0.42",
          ranges: [
            { range: "<=2.0.0", status: "supported" },
            { range: ">2.0.0", status: "broken" },
          ],
        },
      ],
    };
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry({ ...baseProvider, version: "1.0.0" });
      const capabilities = makeProviderMaintenanceCapabilities({
        provider: CODEX_DRIVER,
        packageName: "@openai/codex",
        updateExecutable: "/opt/homebrew/bin/brew",
        updateArgs: ["upgrade", "--cask", "codex"],
        updateLockKey: "homebrew",
        latestVersion: null,
        lookupLatestVersion: Effect.sync(() => latest),
      });
      const updater = yield* makeTestRunner(
        {
          ...registry,
          getProviderMaintenanceCapabilitiesForInstance: () => Effect.succeed(capabilities),
        },
        manifest,
      );

      const unchanged = yield* updater.updateProvider(CODEX_DRIVER);
      assert.strictEqual(unchanged.providers[0]?.updateState?.status, "unchanged");
      assert.match(unchanged.providers[0]?.updateState?.message ?? "", /outdated provider version/);
      assert.deepStrictEqual(calls, ["upgrade --cask codex"]);

      latest = "3.0.0";
      const refused = yield* updater.updateProvider(CODEX_DRIVER);
      assert.strictEqual(refused.providers[0]?.updateState?.status, "failed");
      assert.match(refused.providers[0]?.updateState?.message ?? "", /incompatible/);
      assert.deepStrictEqual(calls, ["upgrade --cask codex"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Homebrew's latest should not come from npm")),
          ),
          layerMockSpawner((_command, args) => {
            calls.push(args.join(" "));
            latest = "2.0.0";
            return { stdout: "upgraded" };
          }),
        ),
      ),
    );
  },
);

it.effect("refuses incompatible latest versions and unapproved or unpinnable targets", () => {
  const calls: string[] = [];
  const manifest: ModelManifest.ModelManifestData = {
    version: 1,
    currentModels: {},
    compatibility: [
      {
        driver: "codex",
        t3CodeRange: ">=0.0.42",
        recommendedVersion: "2.0.0",
        ranges: [
          { range: "=2.0.0", status: "supported" },
          { range: ">2.0.0", status: "broken" },
        ],
      },
    ],
  };
  return Effect.gen(function* () {
    const { registry, providersRef } = yield* makeRegistry();
    const pinnedCapabilities = makeProviderMaintenanceCapabilities({
      provider: CODEX_DRIVER,
      packageName: "@openai/codex",
      updateExecutable: "npm",
      updateArgs: ["install", "-g", "@openai/codex@latest"],
      updateLockKey: "npm-global:/fixture",
    });
    const updater = yield* makeTestRunner(
      {
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: () => Effect.succeed(pinnedCapabilities),
      },
      manifest,
    );
    for (const targetVersion of [undefined, "", "1.0.0", "2.0.0; echo unsafe"]) {
      const result = yield* updater.updateProvider({
        provider: CODEX_DRIVER,
        ...(targetVersion !== undefined ? { targetVersion } : {}),
      });
      assert.strictEqual(result.providers[0]?.updateState?.status, "failed");
    }
    assert.deepStrictEqual(calls, []);
    yield* Ref.update(providersRef, (providers) =>
      providers.map((entry) => ({ ...entry, version: "2.0.0" })),
    );
    const installed = yield* updater.updateProvider({
      provider: CODEX_DRIVER,
      targetVersion: "2.0.0",
    });
    assert.deepStrictEqual(calls, ["install -g @openai/codex@2.0.0"]);
    assert.strictEqual(installed.providers[0]?.updateState?.status, "succeeded");
    yield* Ref.update(providersRef, (providers) =>
      providers.map((entry) => ({ ...entry, version: "1.0.0" })),
    );
    const unchanged = yield* updater.updateProvider({
      provider: CODEX_DRIVER,
      targetVersion: "2.0.0",
    });
    assert.strictEqual(unchanged.providers[0]?.updateState?.status, "unchanged");
    const nativeUpdater = yield* makeTestRunner(
      {
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: () =>
          Effect.succeed({
            ...pinnedCapabilities,
            update: { ...pinnedCapabilities.update!, lockKey: "codex-native" },
          }),
      },
      manifest,
    );
    const refused = yield* nativeUpdater.updateProvider({
      provider: CODEX_DRIVER,
      targetVersion: "2.0.0",
    });
    assert.strictEqual(refused.providers[0]?.updateState?.status, "failed");
    assert.strictEqual(calls.length, 2);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        layerNonWindowsPlatform,
        layerLatestVersionHttpClient("3.0.0"),
        layerMockSpawner((_command, args) => {
          calls.push(args.join(" "));
          return { stdout: "installed" };
        }),
      ),
    ),
  );
});

it.effect("background updates run only a pinned install that shouldStart allows", () => {
  const calls: string[] = [];
  return Effect.gen(function* () {
    const { registry } = yield* makeRegistry({ ...baseProvider, version: "2.0.0" });
    const withCapabilities = (capabilities: ProviderMaintenanceCapabilities) =>
      makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: () => Effect.succeed(capabilities),
      });
    const pinned = yield* withCapabilities(
      makeProviderMaintenanceCapabilities({
        provider: CODEX_DRIVER,
        packageName: "@openai/codex",
        updateExecutable: "npm",
        updateArgs: ["install", "-g", "@openai/codex@latest"],
        updateLockKey: "npm-global:/fixture",
      }),
    );

    const declined = yield* pinned.updateProvider({
      provider: CODEX_DRIVER,
      targetVersion: "2.0.0",
      autoUpdate: { shouldStart: Effect.succeed(false) },
    });
    assert.strictEqual(declined.providers[0]?.updateState, undefined);
    assert.deepStrictEqual(calls, []);

    const tested = yield* pinned.updateProvider({
      provider: CODEX_DRIVER,
      targetVersion: "2.0.0",
      autoUpdate: { shouldStart: Effect.succeed(true) },
    });
    assert.strictEqual(tested.providers[0]?.updateState?.status, "succeeded");
    assert.deepStrictEqual(calls, ["install -g @openai/codex@2.0.0"]);

    // Homebrew cannot be held to a version, so it never runs in the background.
    const brew = yield* withCapabilities(
      makeProviderMaintenanceCapabilities({
        provider: CODEX_DRIVER,
        packageName: "@openai/codex",
        updateExecutable: "brew",
        updateArgs: ["upgrade", "codex"],
        updateLockKey: "homebrew",
        latestVersion: "2.0.0",
      }),
    );
    const unpinned = yield* brew.updateProvider({
      provider: CODEX_DRIVER,
      targetVersion: "2.0.0",
      autoUpdate: { shouldStart: Effect.succeed(true) },
    });
    assert.strictEqual(unpinned.providers[0]?.updateState?.status, "failed");
    assert.strictEqual(calls.length, 1);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        layerNonWindowsPlatform,
        layerLatestVersionHttpClient("3.0.0"),
        layerMockSpawner((_command, args) => {
          calls.push(args.join(" "));
          return { stdout: "installed" };
        }),
      ),
    ),
  );
});

it.effect(
  "native installs pin the tested version in the background and update to latest manually",
  () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry({ ...baseProvider, version: "2.0.0" });
      const executable = "/home/developer/.local/bin/native-cli";
      const native = makeProviderMaintenanceCapabilities({
        provider: CODEX_DRIVER,
        packageName: "@openai/codex",
        updateExecutable: executable,
        updateArgs: ["update"],
        updateLockKey: "codex-native",
      });
      const runner = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: () =>
          Effect.succeed({
            ...native,
            pinnedUpdate: (version) => ({
              command: `${executable} install ${version}`,
              executable,
              args: ["install", version],
              lockKey: "codex-native",
            }),
          }),
      });

      const background = yield* runner.updateProvider({
        provider: CODEX_DRIVER,
        targetVersion: "2.0.0",
        autoUpdate: { shouldStart: Effect.succeed(true) },
      });
      assert.strictEqual(background.providers[0]?.updateState?.status, "succeeded");

      const manual = yield* runner.updateProvider(CODEX_DRIVER);
      assert.strictEqual(manual.providers[0]?.updateState?.status, "succeeded");
      assert.deepStrictEqual(calls, [`${executable} install 2.0.0`, `${executable} update`]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("2.0.0"),
          layerMockSpawner((command, args) => {
            calls.push([command, ...args].join(" "));
            return { stdout: "installed" };
          }),
        ),
      ),
    );
  },
);

it.effect(
  "checks a background update under the install lock and skips it while another server holds it",
  () => {
    const calls: string[] = [];
    const held: string[] = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry({ ...baseProvider, version: "1.0.0" });
      const pinnedRegistry: ProviderRegistry.ProviderRegistry["Service"] = {
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: () =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider: CODEX_DRIVER,
              packageName: "@openai/codex",
              updateExecutable: "npm",
              updateArgs: ["install", "-g", "@openai/codex@latest"],
              updateLockKey: "npm-global:/fixture",
            }),
          ),
      };
      const free = yield* makeTestRunner(pinnedRegistry, undefined, {
        tryRun: (lockKey, run) =>
          Effect.sync(() => held.push(lockKey)).pipe(
            Effect.andThen(run(() => Effect.void)),
            Effect.asSome,
            Effect.ensuring(Effect.sync(() => held.pop())),
          ),
      });
      let checkedUnderLock: ReadonlyArray<string> = [];
      yield* free.updateProvider({
        provider: CODEX_DRIVER,
        targetVersion: "2.0.0",
        autoUpdate: {
          shouldStart: Effect.sync(() => {
            checkedUnderLock = [...held];
            return false;
          }),
        },
      });
      assert.deepStrictEqual(checkedUnderLock, ["npm-global:/fixture"]);
      assert.deepStrictEqual(calls, []);

      const elsewhere = yield* makeTestRunner(pinnedRegistry, undefined, {
        tryRun: () => Effect.succeedNone,
      });
      let checked = false;
      const background = yield* elsewhere.updateProvider({
        provider: CODEX_DRIVER,
        targetVersion: "2.0.0",
        autoUpdate: { shouldStart: Effect.sync(() => (checked = true)) },
      });
      assert.strictEqual(background.providers[0]?.updateState, undefined);
      assert.isFalse(checked);

      const manual = yield* elsewhere.updateProvider(CODEX_DRIVER);
      assert.strictEqual(manual.providers[0]?.updateState?.status, "failed");
      assert.strictEqual(
        manual.providers[0]?.updateState?.message,
        "Another update is running for this provider on this machine. Try again when it finishes.",
      );
      assert.deepStrictEqual(calls, []);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("3.0.0"),
          layerMockSpawner((_command, args) => {
            calls.push(args.join(" "));
            return { stdout: "installed" };
          }),
        ),
      ),
    );
  },
);

describe("provider.update.finished", () => {
  type RecordedEvent = { readonly event: string; readonly properties: unknown };
  const finished = (properties: Record<string, unknown>) => ({
    event: "provider.update.finished",
    properties: {
      source: "manual",
      takeover: false,
      driver: "codex",
      // The shared fixture's bare `npm-global` lock key is not one npm installs produce.
      installerKind: "native",
      fromVersion: "1.0.0",
      targetVersion: null,
      resultVersion: "1.0.0",
      outcome: "failed",
      failureReason: null,
      durationMs: 0,
      ...properties,
    },
  });

  it.effect("records one success with versions, installer and duration", () => {
    const events: Array<RecordedEvent> = [];
    return Effect.gen(function* () {
      const { registry, providersRef } = yield* makeRegistry({ ...baseProvider, version: "1.0.0" });
      const updater = yield* makeTestRunner(
        {
          ...registry,
          refreshAfterUpdate: () =>
            TestClock.adjust(1_500).pipe(
              Effect.andThen(
                Ref.updateAndGet(providersRef, (providers) =>
                  providers.map((provider) => ({ ...provider, version: "2.0.0" })),
                ),
              ),
            ),
        },
        undefined,
        {},
        events,
      );
      yield* updater.updateProvider(CODEX_DRIVER);
      assert.deepStrictEqual(events, [
        finished({ resultVersion: "2.0.0", outcome: "success", durationMs: 1_500 }),
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("2.0.0"),
          layerMockSpawner(() => ({ stdout: "updated /synthetic/private/path" })),
        ),
      ),
    );
  });

  it.effect("classifies a refused install without sending its output", () => {
    const events: Array<RecordedEvent> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry({ ...baseProvider, version: "1.0.0" });
      const updater = yield* makeTestRunner(registry, undefined, {}, events);
      yield* updater.updateProvider(CODEX_DRIVER);
      assert.deepStrictEqual(events, [finished({ failureReason: "permission_denied" })]);
      assert.notInclude(JSON.stringify(events), "synthetic");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("2.0.0"),
          layerMockSpawner(() => ({
            stderr: "npm ERR! code EACCES /synthetic/private/lib/node_modules",
            code: 243,
          })),
        ),
      ),
    );
  });

  it.effect("records a timed-out install", () => {
    const events: Array<RecordedEvent> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry({ ...baseProvider, version: "1.0.0" });
      const updater = yield* makeTestRunner(registry, undefined, {}, events);
      const fiber = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.minutes(5));
      yield* Fiber.join(fiber);
      assert.deepStrictEqual(events, [
        finished({ failureReason: "timeout", durationMs: Duration.toMillis(Duration.minutes(5)) }),
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("2.0.0"),
          layerMockSpawner(() => ({ exitCode: Effect.never })),
        ),
      ),
    );
  });

  it.effect("records an install that leaves the provider failing its health check", () => {
    const events: Array<RecordedEvent> = [];
    return Effect.gen(function* () {
      const { registry, providersRef } = yield* makeRegistry({ ...baseProvider, version: "1.0.0" });
      const updater = yield* makeTestRunner(
        {
          ...registry,
          refreshAfterUpdate: () =>
            Ref.updateAndGet(providersRef, (providers) =>
              providers.map((provider) => ({
                ...provider,
                version: "2.0.0",
                status: "error" as const,
                message: "synthetic probe failure",
              })),
            ),
        },
        undefined,
        {},
        events,
      );
      yield* updater.updateProvider(CODEX_DRIVER);
      assert.deepStrictEqual(events, [
        finished({
          resultVersion: "2.0.0",
          outcome: "unchanged",
          failureReason: "provider_error_after_install",
        }),
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("2.0.0"),
          layerMockSpawner(() => ({ stdout: "updated" })),
        ),
      ),
    );
  });

  it.effect("records a failed post-update refresh as could not verify", () => {
    const events: Array<RecordedEvent> = [];
    return Effect.gen(function* () {
      const { registry, providersRef } = yield* makeRegistry({ ...baseProvider, version: "1.0.0" });
      const updater = yield* makeTestRunner(
        {
          ...registry,
          refreshAfterUpdate: () =>
            Ref.update(providersRef, (providers) =>
              providers.map((provider) => ({
                ...provider,
                status: "error" as const,
                message: "Provider refresh failed after update.",
              })),
            ).pipe(Effect.as([])),
        },
        undefined,
        {},
        events,
      );
      const result = yield* updater.updateProvider(CODEX_DRIVER);
      assert.notInclude(result.providers[0]?.updateState?.message ?? "", "reports an error");
      assert.deepStrictEqual(events, [
        finished({ outcome: "unchanged", failureReason: "unchanged_after_install" }),
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("2.0.0"),
          layerMockSpawner(() => ({ stdout: "updated" })),
        ),
      ),
    );
  });

  it.effect("records a background update once and a declined one not at all", () => {
    const events: Array<RecordedEvent> = [];
    return Effect.gen(function* () {
      const { registry, providersRef } = yield* makeRegistry({ ...baseProvider, version: "1.0.0" });
      const updater = yield* makeTestRunner(
        {
          ...registry,
          refreshAfterUpdate: () =>
            Ref.updateAndGet(providersRef, (providers) =>
              providers.map((provider) => ({ ...provider, version: "2.0.0" })),
            ),
          getProviderMaintenanceCapabilitiesForInstance: () =>
            Effect.succeed(
              makeProviderMaintenanceCapabilities({
                provider: CODEX_DRIVER,
                packageName: "@openai/codex",
                updateExecutable: "npm",
                updateArgs: ["install", "-g", "@openai/codex@latest"],
                updateLockKey: "npm-global:/synthetic/prefix",
              }),
            ),
        },
        undefined,
        {},
        events,
      );
      yield* updater.updateProvider({
        provider: CODEX_DRIVER,
        targetVersion: "2.0.0",
        autoUpdate: { shouldStart: Effect.succeed(false) },
      });
      assert.deepStrictEqual(events, []);
      yield* updater.updateProvider({
        provider: CODEX_DRIVER,
        targetVersion: "2.0.0",
        autoUpdate: { shouldStart: Effect.succeed(true) },
      });
      assert.deepStrictEqual(events, [
        finished({
          source: "background",
          installerKind: "npm",
          targetVersion: "2.0.0",
          resultVersion: "2.0.0",
          outcome: "success",
        }),
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("3.0.0"),
          layerMockSpawner(() => ({ stdout: "installed" })),
        ),
      ),
    );
  });

  it.effect("records a takeover, verified only once the provider's own updater is off", () => {
    const events: Array<RecordedEvent> = [];
    const calls: string[] = [];
    // The marker is there until a pinned install that removes it runs.
    let selfUpdaterActive = true;
    let installRemovesMarker = true;
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry({ ...baseProvider, version: "2.0.0" });
      const executable = "/home/developer/.local/bin/codex";
      const updater = yield* makeTestRunner(
        {
          ...registry,
          getProviderMaintenanceCapabilitiesForInstance: () =>
            Effect.succeed({
              ...makeProviderMaintenanceCapabilities({
                provider: CODEX_DRIVER,
                packageName: "@openai/codex",
                updateExecutable: executable,
                updateArgs: ["update"],
                updateLockKey: "codex-native",
              }),
              selfUpdaterActive,
              pinnedUpdate: (version) => ({
                command: `install ${version}`,
                executable: "/bin/sh",
                args: ["install", version],
                lockKey: "codex-native",
              }),
            }),
        },
        undefined,
        {},
        events,
      );
      const takeover = () =>
        updater.updateProvider({
          provider: CODEX_DRIVER,
          targetVersion: "2.0.0",
          autoUpdate: { shouldStart: Effect.succeed(true), takeover: true },
        });

      const handedOver = yield* takeover();
      assert.strictEqual(handedOver.providers[0]?.updateState?.status, "succeeded");
      // An install that leaves the provider's own updater on did not take over.
      selfUpdaterActive = true;
      installRemovesMarker = false;
      const stillOwned = yield* takeover();
      assert.strictEqual(stillOwned.providers[0]?.updateState?.status, "unchanged");
      assert.deepStrictEqual(calls, ["install 2.0.0", "install 2.0.0"]);
      const takeoverEvent = {
        source: "background",
        takeover: true,
        installerKind: "native",
        fromVersion: "2.0.0",
        targetVersion: "2.0.0",
        resultVersion: "2.0.0",
      };
      assert.deepStrictEqual(events, [
        finished({ ...takeoverEvent, outcome: "success" }),
        finished({
          ...takeoverEvent,
          failureReason: "unchanged_after_install",
          outcome: "unchanged",
        }),
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("3.0.0"),
          layerMockSpawner((_command, args) => {
            calls.push(args.join(" "));
            if (installRemovesMarker) selfUpdaterActive = false;
            return { stdout: "installed" };
          }),
        ),
      ),
    );
  });

  it.effect(
    "keeps the provider's own updater off after background installs and hands it back",
    () => {
      const steps: string[] = [];
      const run = (autoUpdate: boolean, managedUpdates: boolean) =>
        Effect.gen(function* () {
          const { registry } = yield* makeRegistry({ ...baseProvider, version: "2.0.0" });
          const updater = yield* makeTestRunner(
            {
              ...registry,
              getProviderMaintenanceCapabilitiesForInstance: () =>
                Effect.succeed({
                  ...makeProviderMaintenanceCapabilities({
                    provider: CODEX_DRIVER,
                    packageName: "@openai/codex",
                    updateExecutable: "/home/developer/.local/bin/claude",
                    updateArgs: ["update"],
                    updateLockKey: "claudeAgent-native",
                  }),
                  pinnedUpdate: (version) => ({
                    command: `install ${version}`,
                    executable: "/home/developer/.local/bin/claude",
                    args: ["install", version],
                    lockKey: "claudeAgent-native",
                  }),
                  selfUpdater: {
                    turnOff: Effect.sync(() => void steps.push("turnOff")),
                    handBack: Effect.sync(() => void steps.push("handBack")),
                  },
                }),
            },
            undefined,
            {},
            [],
            { autoUpdateProviders: managedUpdates },
          );
          yield* updater.updateProvider(
            autoUpdate
              ? {
                  provider: CODEX_DRIVER,
                  targetVersion: "2.0.0",
                  autoUpdate: { shouldStart: Effect.succeed(true) },
                }
              : CODEX_DRIVER,
          );
        });
      return Effect.gen(function* () {
        yield* run(true, true);
        // A manual update while styal manages updates keeps the updater off.
        yield* run(false, true);
        yield* run(false, false);
        assert.deepStrictEqual(steps, ["install 2.0.0", "turnOff", "update", "update", "handBack"]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerNonWindowsPlatform,
            layerLatestVersionHttpClient("2.0.0"),
            layerMockSpawner((_command, args) => {
              steps.push(args.join(" "));
              return { stdout: "installed" };
            }),
          ),
        ),
      );
    },
  );

  it.effect("runs Windows Claude pins without a shell and preserves updater ownership", () => {
    const events: Array<RecordedEvent> = [];
    const binaryPath = "C:\\Users\\Dev Team's\\.local\\bin\\claude.exe";
    const calls: Array<{ command: string; args: ReadonlyArray<string>; shell: unknown }> = [];
    const lockKeys: string[] = [];
    const childPids: number[] = [];
    let installedVersion = "2.1.302";
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const services = yield* Effect.context<ProviderMaintenanceResolverServices>();
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "styal-windows-claude-runner-" });
      const configDir = path.join(root, ".claude");
      const settingsPath = path.join(configDir, "settings.json");
      const resolve = makeClaudeMaintenance({
        configDir,
        accountConfigPath: path.join(root, ".claude.json"),
      })
        .resolve({
          binaryPath,
          resolvedCommandPath: binaryPath,
          realCommandPath: binaryPath,
          env: {},
          platform: "win32",
        })
        .pipe(Effect.provideContext(services));
      const driver = ProviderDriverKind.make("claudeAgent");
      const { registry, providersRef } = yield* makeRegistry({
        ...baseProvider,
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver,
        version: installedVersion,
      });
      const makeRunner = (managedUpdates: boolean) =>
        makeTestRunner(
          {
            ...registry,
            getProviderMaintenanceCapabilitiesForInstance: () => resolve,
            refreshAfterUpdate: () =>
              Ref.updateAndGet(providersRef, (providers) =>
                providers.map((provider) => ({ ...provider, version: installedVersion })),
              ),
          },
          { version: 1, currentModels: {}, compatibility: [] },
          {
            tryRun: (lockKey, run) => {
              lockKeys.push(lockKey);
              return run((pid) => Effect.sync(() => void childPids.push(pid))).pipe(Effect.asSome);
            },
          },
          events,
          { autoUpdateProviders: managedUpdates },
        );
      const managed = yield* makeRunner(true);
      const background = yield* managed.updateProvider({
        provider: driver,
        targetVersion: "2.1.303",
        autoUpdate: { shouldStart: Effect.succeed(true) },
      });
      assert.strictEqual(background.providers[0]?.updateState?.status, "succeeded");
      assert.strictEqual((yield* resolve).selfUpdaterActive, false);
      const ownedSettings = yield* fs.readFileString(settingsPath);
      const manualManaged = yield* managed.updateProvider(driver);
      assert.strictEqual(manualManaged.providers[0]?.updateState?.status, "succeeded");
      assert.strictEqual(yield* fs.readFileString(settingsPath), ownedSettings);
      const unmanaged = yield* makeRunner(false);
      const manual = yield* unmanaged.updateProvider(driver);
      assert.strictEqual(manual.providers[0]?.updateState?.status, "succeeded");
      assert.strictEqual((yield* resolve).selfUpdaterActive, true);
      assert.deepStrictEqual(calls, [
        { command: binaryPath, args: ["install", "2.1.303"], shell: false },
        { command: binaryPath, args: ["update"], shell: false },
        { command: binaryPath, args: ["update"], shell: false },
      ]);
      assert.deepStrictEqual(lockKeys, Array(3).fill("claudeAgent-native"));
      assert.deepStrictEqual(childPids, [1, 1, 1]);
      assert.deepStrictEqual(
        events,
        ["background", "manual", "manual"].map((source, index) =>
          finished({
            source,
            driver: "claudeAgent",
            fromVersion: index === 0 ? "2.1.302" : "2.1.303",
            targetVersion: index === 0 ? "2.1.303" : null,
            resultVersion: "2.1.303",
            outcome: "success",
          }),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(SpawnExecutableResolution, () => binaryPath),
          layerLatestVersionHttpClient("2.1.303"),
          layerMockSpawner((command, args, options) => {
            calls.push({ command, args, shell: options.shell });
            installedVersion = "2.1.303";
            return { stdout: "installed" };
          }),
        ),
      ),
      Effect.scoped,
    );
  });

  it.effect("records an interrupted install once", () => {
    const events: Array<RecordedEvent> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry({ ...baseProvider, version: "1.0.0" });
      const running = yield* Deferred.make<void>();
      const updater = yield* makeTestRunner(
        {
          ...registry,
          setProviderMaintenanceActionState: (input) =>
            registry
              .setProviderMaintenanceActionState(input)
              .pipe(
                Effect.tap(() =>
                  input.state?.message?.startsWith("Running ")
                    ? Deferred.succeed(running, undefined)
                    : Effect.void,
                ),
              ),
        },
        undefined,
        {},
        events,
      );
      const fiber = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkChild);
      yield* Deferred.await(running);
      yield* Fiber.interrupt(fiber);
      assert.deepStrictEqual(events, [
        finished({ resultVersion: null, failureReason: "interrupted" }),
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("2.0.0"),
          layerMockSpawner(() => ({ exitCode: Effect.never })),
        ),
      ),
    );
  });

  it.effect("records a manual update refused while another install holds the lock", () => {
    const events: Array<RecordedEvent> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry({ ...baseProvider, version: "1.0.0" });
      const updater = yield* makeTestRunner(
        registry,
        undefined,
        { tryRun: () => Effect.succeedNone },
        events,
      );
      yield* updater.updateProvider(CODEX_DRIVER);
      assert.deepStrictEqual(events, [finished({ failureReason: "install_in_progress" })]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("2.0.0"),
          layerMockSpawner(() => ({ stdout: "updated" })),
        ),
      ),
    );
  });

  it.effect("records nothing for a background update dropped because the lock is held", () => {
    const events: Array<RecordedEvent> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry({ ...baseProvider, version: "1.0.0" });
      const updater = yield* makeTestRunner(
        registry,
        undefined,
        { tryRun: () => Effect.succeedNone },
        events,
      );
      yield* updater.updateProvider({
        provider: CODEX_DRIVER,
        targetVersion: "2.0.0",
        autoUpdate: { shouldStart: Effect.succeed(true) },
      });
      assert.deepStrictEqual(events, []);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("2.0.0"),
          layerMockSpawner(() => ({ stdout: "updated" })),
        ),
      ),
    );
  });
});
