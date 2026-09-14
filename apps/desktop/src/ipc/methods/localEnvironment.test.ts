import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopObservability from "../../app/DesktopObservability.ts";
import * as DesktopShutdown from "../../app/DesktopShutdown.ts";
import * as DesktopShutdownGuard from "../../app/DesktopShutdownGuard.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import { getLocalEnvironmentEnabled, setLocalEnvironmentEnabled } from "./localEnvironment.ts";

// `relaunch` declares the lifecycle runtime services as requirements even
// though the mocked relaunch never touches them.
const unusedLifecycleRuntimeLayer = Layer.mergeAll(
  Layer.succeed(
    DesktopObservability.DesktopTrace,
    DesktopObservability.DesktopTrace.of({ flush: Effect.void }),
  ),
  Layer.succeed(DesktopShutdownGuard.DesktopShutdownGuard, {
    confirm: () => Effect.succeed(true),
  }),
  DesktopShutdown.layer,
  DesktopState.layer,
  Layer.succeed(
    DesktopEnvironment.DesktopEnvironment,
    DesktopEnvironment.DesktopEnvironment.of(
      {} as DesktopEnvironment.DesktopEnvironment["Service"],
    ),
  ),
  Layer.mock(DesktopWindow.DesktopWindow, {}),
  Layer.mock(ElectronApp.ElectronApp, {}),
  Layer.mock(ElectronTheme.ElectronTheme, {}),
);

describe("local environment IPC", () => {
  it.effect("relaunches only when the setting changes and keeps other settings", () => {
    const relaunchReasons: Array<string> = [];
    const layer = Layer.mergeAll(
      DesktopAppSettings.layerTest({
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        wslBackendEnabled: true,
      }),
      Layer.mock(DesktopLifecycle.DesktopLifecycle, {
        relaunch: (reason) =>
          Effect.sync(() => {
            relaunchReasons.push(reason);
            return true;
          }),
      }),
      unusedLifecycleRuntimeLayer,
    );
    return Effect.gen(function* () {
      yield* setLocalEnvironmentEnabled.handler(false);
      assert.isFalse(yield* getLocalEnvironmentEnabled.handler());
      yield* setLocalEnvironmentEnabled.handler(false);
      assert.deepEqual(relaunchReasons, ["localEnvironmentEnabled=false"]);

      yield* setLocalEnvironmentEnabled.handler(true);
      assert.isTrue(yield* getLocalEnvironmentEnabled.handler());
      const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
      assert.isTrue((yield* appSettings.get).wslBackendEnabled);
      assert.deepEqual(relaunchReasons, [
        "localEnvironmentEnabled=false",
        "localEnvironmentEnabled=true",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the current setting when the restart is declined", () => {
    const layer = Layer.mergeAll(
      DesktopAppSettings.layerTest(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
      Layer.mock(DesktopLifecycle.DesktopLifecycle, {
        relaunch: () => Effect.succeed(false),
      }),
      unusedLifecycleRuntimeLayer,
    );
    return Effect.gen(function* () {
      yield* setLocalEnvironmentEnabled.handler(false);
      assert.isTrue(yield* getLocalEnvironmentEnabled.handler());
    }).pipe(Effect.provide(layer));
  });
});
