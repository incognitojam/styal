import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as ModelManifest from "./ModelManifest.ts";
import { decideProviderAutoUpdate, make } from "./ProviderAutoUpdater.ts";
import { ProviderMaintenanceRunner } from "./providerMaintenanceRunner.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";

const codex: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "1.0.0",
    latestVersion: "3.0.0",
    updateCommand: "npm install -g @openai/codex@latest",
    canUpdate: true,
    canInstallVersion: true,
    checkedAt: "2026-10-01T00:00:00.000Z",
    message: null,
  },
};

const withAdvisory = (
  advisory: Partial<NonNullable<ServerProvider["versionAdvisory"]>>,
): ServerProvider => ({ ...codex, versionAdvisory: { ...codex.versionAdvisory!, ...advisory } });

const manifest: ModelManifest.ModelManifestData = {
  version: 1,
  currentModels: {},
  compatibility: [
    {
      driver: "codex",
      t3CodeRange: ">=0.0.0",
      autoUpdateVersion: "2.0.0",
      ranges: [{ range: ">=1.0.0", status: "supported" }],
    },
  ],
};

describe("decideProviderAutoUpdate", () => {
  it("pins the verified version when the installer can install one", () => {
    assert.deepStrictEqual(decideProviderAutoUpdate(codex, "2.0.0"), { targetVersion: "2.0.0" });
  });

  it("runs an unpinnable installer only while its latest is the verified version", () => {
    const native = withAdvisory({ canInstallVersion: false });
    assert.strictEqual(decideProviderAutoUpdate(native, "2.0.0"), null);
    assert.deepStrictEqual(
      decideProviderAutoUpdate(
        { ...native, versionAdvisory: { ...native.versionAdvisory!, latestVersion: "2.0.0" } },
        "2.0.0",
      ),
      { targetVersion: undefined },
    );
  });

  it("leaves current, newer, unknown, disabled and manual installs alone", () => {
    for (const provider of [
      { ...codex, version: "2.0.0" },
      { ...codex, version: "2.1.0" },
      { ...codex, version: "2.1.0-beta.1" },
      { ...codex, version: null },
      { ...codex, enabled: false },
      { ...codex, installed: false },
      { ...codex, status: "error" as const },
      withAdvisory({ canUpdate: false }),
    ]) {
      assert.strictEqual(decideProviderAutoUpdate(provider, "2.0.0"), null);
    }
    assert.strictEqual(decideProviderAutoUpdate(codex, null), null);
  });
});

const testLayer = (input: {
  readonly settings?: Partial<ServerSettings>;
  readonly threadStatus?: string;
  readonly calls: Array<unknown>;
}) =>
  Layer.mergeAll(
    // Only `devUrl` is read; the service has no partial form.
    Layer.succeed(ServerConfig, { devUrl: undefined } as never),
    ServerSettingsService.layerTest(input.settings ?? {}),
    Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codex]) }),
    Layer.mock(ModelManifest.ModelManifest)({ refresh: Effect.succeed(manifest) }),
    Layer.mock(ProjectionStoreV2)({
      getShellSnapshot: () =>
        Effect.succeed({
          threads: input.threadStatus
            ? [{ id: "thread", status: input.threadStatus, pendingRuntimeRequest: null }]
            : [],
        } as never),
    }),
    Layer.mock(ProviderMaintenanceRunner)({
      updateProvider: (target) => {
        input.calls.push(target);
        return Effect.succeed({ providers: [] });
      },
    }),
  );

const runPassWith = (input: Parameters<typeof testLayer>[0]) =>
  Effect.flatMap(make, (updater) => updater.runPass).pipe(Effect.provide(testLayer(input)));

describe("ProviderAutoUpdater.runPass", () => {
  it.effect("installs the verified version once per window", () => {
    const calls: Array<unknown> = [];
    return Effect.gen(function* () {
      const updater = yield* make;
      yield* updater.runPass;
      yield* updater.runPass;
      assert.deepStrictEqual(calls, [
        {
          provider: "codex",
          instanceId: "codex",
          targetVersion: "2.0.0",
          autoUpdate: true,
        },
      ]);
    }).pipe(Effect.provide(testLayer({ calls })));
  });

  it.effect("waits while a thread is running or waiting on the user", () => {
    const calls: Array<unknown> = [];
    return Effect.gen(function* () {
      yield* runPassWith({ threadStatus: "running", calls });
      yield* runPassWith({ threadStatus: "waiting", calls });
      assert.deepStrictEqual(calls, []);
      yield* runPassWith({ threadStatus: "completed", calls });
      assert.strictEqual(calls.length, 1);
    });
  });

  it.effect("does nothing when automatic updates or update checks are off", () => {
    const calls: Array<unknown> = [];
    return Effect.gen(function* () {
      yield* runPassWith({ settings: { autoUpdateProviders: false }, calls });
      yield* runPassWith({ settings: { enableProviderUpdateChecks: false }, calls });
      assert.deepStrictEqual(calls, []);
    });
  });
});
