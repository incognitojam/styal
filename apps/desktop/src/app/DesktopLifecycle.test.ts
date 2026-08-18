import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopObservability from "./DesktopObservability.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const makeElectronApp = (
  overrides: Partial<ElectronApp.ElectronApp["Service"]> = {},
): ElectronApp.ElectronApp["Service"] => ({
  metadata: Effect.die("unexpected metadata read"),
  name: Effect.succeed("T3 Code"),
  systemLocale: Effect.succeed("en-US"),
  whenReady: Effect.void,
  quit: Effect.void,
  exit: () => Effect.void,
  relaunch: () => Effect.void,
  setPath: () => Effect.void,
  setName: () => Effect.void,
  setAboutPanelOptions: () => Effect.void,
  setAppUserModelId: () => Effect.void,
  getAppMetrics: Effect.succeed([]),
  isDefaultProtocolClient: () => Effect.succeed(false),
  setAsDefaultProtocolClient: () => Effect.succeed(true),
  setDesktopName: () => Effect.void,
  setDockIcon: () => Effect.void,
  appendCommandLineSwitch: () => Effect.void,
  removeCommandLineSwitch: () => Effect.void,
  onBeforeQuitForUpdate: () => Effect.void,
  on: () => Effect.void,
  once: () => Effect.void,
  ...overrides,
});

const makeDesktopWindowLayer = (closeMainForShutdown: Effect.Effect<void> = Effect.void) =>
  Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected window creation"),
    ensureMain: Effect.die("unexpected window creation"),
    revealOrCreateMain: Effect.die("unexpected window creation"),
    activate: Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: Effect.void,
    closeMainForShutdown,
    dispatchMenuAction: () => Effect.void,
    zoomMain: () => Effect.void,
    syncAppearance: Effect.void,
  });

const electronThemeLayer = Layer.succeed(ElectronTheme.ElectronTheme, {
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
  onUpdated: () => Effect.void,
});

const makeLifecycleLayer = (
  platform: NodeJS.Platform,
  electronApp: ElectronApp.ElectronApp["Service"],
  flushTrace: Effect.Effect<void> = Effect.void,
  closeMainForShutdown: Effect.Effect<void> = Effect.void,
) =>
  DesktopLifecycle.layer.pipe(
    Layer.provideMerge(Layer.succeed(ElectronApp.ElectronApp, electronApp)),
    Layer.provideMerge(electronThemeLayer),
    Layer.provideMerge(makeDesktopWindowLayer(closeMainForShutdown)),
    Layer.provideMerge(
      Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform,
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]),
    ),
    Layer.provideMerge(
      Layer.succeed(
        DesktopObservability.DesktopTrace,
        DesktopObservability.DesktopTrace.of({ flush: flushTrace }),
      ),
    ),
    Layer.provideMerge(DesktopShutdown.layer),
    Layer.provideMerge(DesktopState.layer),
  );

describe("DesktopLifecycle", () => {
  for (const platform of ["darwin", "win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>) {
    it.effect(`lets the updater's quit event proceed on ${platform}`, () => {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();

      const electronApp = makeElectronApp({
        onBeforeQuitForUpdate: (listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              appListeners.set("before-quit-for-update", listener);
            }),
            () =>
              Effect.sync(() => {
                appListeners.delete("before-quit-for-update");
              }),
          ).pipe(Effect.asVoid),
        on: (eventName, listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              appListeners.set(
                eventName,
                listener as unknown as (...args: readonly unknown[]) => void,
              );
            }),
            () =>
              Effect.sync(() => {
                appListeners.delete(eventName);
              }),
          ).pipe(Effect.asVoid),
      });

      return Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          appListeners.get("before-quit-for-update")?.();

          let prevented = false;
          const event = {
            preventDefault: () => {
              prevented = true;
            },
          } as Electron.Event;
          appListeners.get("before-quit")?.(event);

          assert.isFalse(
            prevented,
            "cancelling this event prevents the updater from completing its relaunch",
          );

          const state = yield* DesktopState.DesktopState;
          assert.isTrue(yield* Ref.get(state.quitting));
        }),
      ).pipe(Effect.provide(makeLifecycleLayer(platform, electronApp)));
    });
  }

  it.effect("flushes shutdown spans and records Electron's will-quit milestone", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const onceListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const traceFlushed = yield* Deferred.make<void>();
      let flushCount = 0;
      let quitCount = 0;
      const electronApp = makeElectronApp({
        quit: Effect.sync(() => {
          quitCount += 1;
          appListeners.get("before-quit")?.({ preventDefault: () => undefined } as Electron.Event);
          const willQuit = onceListeners.get("will-quit");
          onceListeners.delete("will-quit");
          willQuit?.();
        }),
        on: (eventName, listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              appListeners.set(
                eventName,
                listener as unknown as (...args: readonly unknown[]) => void,
              );
            }),
            () =>
              Effect.sync(() => {
                appListeners.delete(eventName);
              }),
          ).pipe(Effect.asVoid),
        once: (eventName, listener) =>
          Effect.sync(() => {
            onceListeners.set(
              eventName,
              listener as unknown as (...args: readonly unknown[]) => void,
            );
          }),
      });
      const flushTrace = Effect.sync(() => {
        flushCount += 1;
      }).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            flushCount >= 5 ? Deferred.succeed(traceFlushed, undefined) : Effect.void,
          ),
        ),
        Effect.asVoid,
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          const shutdown = yield* DesktopShutdown.DesktopShutdown;
          yield* lifecycle.register;

          let prevented = false;
          appListeners.get("before-quit")?.({
            preventDefault: () => {
              prevented = true;
            },
          } as Electron.Event);

          yield* shutdown.awaitRequest;
          yield* shutdown.markComplete;
          yield* Deferred.await(traceFlushed);

          assert.isTrue(prevented);
          assert.equal(quitCount, 1);
          assert.equal(flushCount, 5);
          assert.isFalse(onceListeners.has("will-quit"));
        }),
      ).pipe(Effect.provide(makeLifecycleLayer("darwin", electronApp, flushTrace)));
    }),
  );

  it.effect("closes the main window before requesting application cleanup", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const closeStarted = yield* Deferred.make<void>();
      const allowClose = yield* Deferred.make<void>();
      const electronApp = makeElectronApp({
        on: (eventName, listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              appListeners.set(
                eventName,
                listener as unknown as (...args: readonly unknown[]) => void,
              );
            }),
            () =>
              Effect.sync(() => {
                appListeners.delete(eventName);
              }),
          ).pipe(Effect.asVoid),
      });
      const closeMainForShutdown = Deferred.succeed(closeStarted, undefined).pipe(
        Effect.andThen(Deferred.await(allowClose)),
        Effect.asVoid,
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          const shutdown = yield* DesktopShutdown.DesktopShutdown;
          yield* lifecycle.register;
          const shutdownObserved = yield* Deferred.make<void>();
          const shutdownRequested = yield* shutdown.awaitRequest.pipe(
            Effect.andThen(Deferred.succeed(shutdownObserved, undefined)),
            Effect.forkChild({ startImmediately: true }),
          );

          appListeners.get("before-quit")?.({
            preventDefault: () => undefined,
          } as Electron.Event);

          yield* Deferred.await(closeStarted);
          yield* Effect.yieldNow;
          assert.isFalse(yield* Deferred.isDone(shutdownObserved));

          yield* Deferred.succeed(allowClose, undefined);
          yield* Deferred.await(shutdownObserved);
          yield* Fiber.join(shutdownRequested);
          yield* shutdown.markComplete;
        }),
      ).pipe(
        Effect.provide(
          makeLifecycleLayer("darwin", electronApp, Effect.void, closeMainForShutdown),
        ),
      );
    }),
  );
});
