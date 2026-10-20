import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import { providerInstallerKind, startProviderInventory } from "./ProviderAnalytics.ts";

const codexDriver = ProviderDriverKind.make("codex");
const claudeDriver = ProviderDriverKind.make("claudeAgent");

const codex: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: codexDriver,
  enabled: true,
  installed: true,
  version: "v1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  compatibilityAdvisory: {
    status: "supported",
    message: null,
    recommendedVersion: null,
    recommendedRange: null,
    verifiedVersion: "2.0.0",
  },
};

// A custom instance whose user-chosen name must never be reported.
const customClaude: ServerProvider = {
  ...codex,
  instanceId: ProviderInstanceId.make("claude_synthetic_work"),
  driver: claudeDriver,
  installed: false,
  version: null,
  status: "error",
  compatibilityAdvisory: { ...codex.compatibilityAdvisory!, verifiedVersion: "2.0.0" },
};

// A standalone Codex install whose own updater is still on.
const nativeCodex: ServerProvider = {
  ...codex,
  instanceId: ProviderInstanceId.make("codex_synthetic_native"),
  version: "2.0.0",
};

const unavailable: ServerProvider = {
  ...codex,
  instanceId: ProviderInstanceId.make("synthetic_missing_driver"),
  driver: ProviderDriverKind.make("syntheticMissingDriver"),
  availability: "unavailable",
};

const npmCapabilities = makeProviderMaintenanceCapabilities({
  provider: codexDriver,
  packageName: "@openai/codex",
  updateExecutable: "npm",
  updateArgs: ["install", "-g", "--prefix", "/synthetic/prefix", "@openai/codex@latest"],
  updateLockKey: "npm-global:/synthetic/prefix",
});

const nativeCapabilities = {
  ...makeProviderMaintenanceCapabilities({
    provider: codexDriver,
    packageName: "@openai/codex",
    updateExecutable: "/synthetic/.local/bin/codex",
    updateArgs: ["update"],
    updateLockKey: "codex-native",
  }),
  pinnedUpdate: (version: string) => ({
    command: `install ${version}`,
    executable: "/bin/sh",
    args: ["install", version],
    lockKey: "codex-native",
  }),
  selfUpdaterActive: true,
};

it("names the installer that owns the executable", () => {
  const withLock = (updateLockKey: string) =>
    providerInstallerKind(
      makeProviderMaintenanceCapabilities({
        provider: codexDriver,
        packageName: null,
        updateExecutable: "synthetic",
        updateArgs: [],
        updateLockKey,
      }),
    );
  assert.deepStrictEqual(
    [
      "npm-global:/synthetic",
      "bun-global",
      "pnpm-global",
      "yarn-global",
      "volta",
      "vite-plus-global",
      "homebrew",
      "codex-native",
      "grok",
    ].map(withLock),
    ["npm", "bun", "pnpm", "yarn", "volta", "vite-plus", "homebrew", "native", "native"],
  );
  assert.strictEqual(
    providerInstallerKind(
      makeManualOnlyProviderMaintenanceCapabilities({ provider: codexDriver, packageName: null }),
    ),
    "unknown",
  );
});

it.effect("reports each available instance after startup settles, then daily", () => {
  const events: Array<{ readonly event: string; readonly properties: unknown }> = [];
  let busySkips = new Map([[codex.instanceId, 3]]);
  const takeBusySkips = Effect.sync(() => {
    const taken = busySkips;
    busySkips = new Map();
    return taken;
  });
  const inventory = (busy: number) => [
    {
      event: "provider.inventory",
      properties: {
        driver: "codex",
        instance: "default",
        installed: true,
        enabled: true,
        status: "ready",
        version: "1.0.0",
        installerKind: "npm",
        canAutoUpdate: true,
        autoUpdatesEnabled: false,
        testedVersion: "2.0.0",
        autoUpdateTargetVersion: "2.0.0",
        autoUpdateBusySkips: busy,
        selfUpdaterActive: null,
      },
    },
    {
      event: "provider.inventory",
      properties: {
        driver: "codex",
        instance: "custom",
        installed: true,
        enabled: true,
        status: "ready",
        version: "2.0.0",
        installerKind: "native",
        canAutoUpdate: true,
        autoUpdatesEnabled: false,
        testedVersion: "2.0.0",
        autoUpdateTargetVersion: null,
        autoUpdateBusySkips: 0,
        // Managed updates would take this install over by reinstalling 2.0.0.
        selfUpdaterActive: true,
      },
    },
    {
      event: "provider.inventory",
      properties: {
        driver: "claudeAgent",
        instance: "custom",
        installed: false,
        enabled: true,
        status: "error",
        version: null,
        installerKind: "unknown",
        canAutoUpdate: false,
        autoUpdatesEnabled: false,
        testedVersion: "2.0.0",
        autoUpdateTargetVersion: null,
        autoUpdateBusySkips: 0,
        selfUpdaterActive: null,
      },
    },
  ];

  return Effect.gen(function* () {
    yield* startProviderInventory(takeBusySkips);
    yield* TestClock.adjust(Duration.minutes(1));
    assert.deepStrictEqual(events, []);

    yield* TestClock.adjust(Duration.minutes(1));
    assert.deepStrictEqual(events, inventory(3));
    assert.notInclude(JSON.stringify(events), "synthetic");

    yield* TestClock.adjust(Duration.hours(24));
    assert.deepStrictEqual(events, [...inventory(3), ...inventory(0)]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
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
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([codex, nativeCodex, customClaude, unavailable]),
          getProviderMaintenanceCapabilitiesForInstance: (instanceId, driver) =>
            Effect.succeed(
              instanceId === nativeCodex.instanceId
                ? nativeCapabilities
                : driver === codexDriver
                  ? npmCapabilities
                  : makeManualOnlyProviderMaintenanceCapabilities({
                      provider: driver,
                      packageName: null,
                    }),
            ),
        }),
        // Update checks on with automatic updates off: not updating automatically.
        ServerSettings.layerTest({ autoUpdateProviders: false }),
      ),
    ),
  );
});
