import * as DesktopShutdownGuard from "./DesktopShutdownGuard.ts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as NodeEvents from "node:events";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopObservability from "./DesktopObservability.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as Option from "effect/Option";

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

const makeElectronWindowLayer = (destroyAll: Effect.Effect<void> = Effect.void) =>
  Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected window creation"),
    main: Effect.die("unexpected main window read"),
    currentMainOrFirst: Effect.die("unexpected current window read"),
    focusedMainOrFirst: Effect.die("unexpected focused window read"),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    reveal: () => Effect.void,
    sendAll: () => Effect.void,
    destroyAll,
    syncAllAppearance: () => Effect.void,
  });

const makeDesktopWindowLayer = (
  closeMainForShutdown: Effect.Effect<void> = Effect.void,
  activate: Effect.Effect<void> = Effect.void,
) =>
  Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected window creation"),
    ensureMain: Effect.die("unexpected window creation"),
    revealOrCreateMain: Effect.die("unexpected window creation"),
    activate,
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
  destroyAll: Effect.Effect<void> = Effect.void,
  activate: Effect.Effect<void> = Effect.void,
  installOnQuit: Effect.Effect<boolean> = Effect.succeed(false),
  confirmShutdown: Effect.Effect<boolean> = Effect.succeed(true),
) =>
  DesktopLifecycle.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(DesktopShutdownGuard.DesktopShutdownGuard, { confirm: () => confirmShutdown }),
    ),
    Layer.provideMerge(
      Layer.succeed(DesktopUpdates.DesktopUpdates, {
        getState: Effect.die("unexpected update state read"),
        emitState: Effect.void,
        disabledReason: Effect.succeed(Option.none()),
        configure: Effect.void,
        setChannel: () => Effect.die("unexpected channel change"),
        check: () => Effect.die("unexpected update check"),
        download: Effect.die("unexpected download"),
        install: Effect.die("unexpected install"),
        installOnQuit,
      }),
    ),
    Layer.provideMerge(Layer.succeed(ElectronApp.ElectronApp, electronApp)),
    Layer.provideMerge(electronThemeLayer),
    Layer.provideMerge(makeElectronWindowLayer(destroyAll)),
    Layer.provideMerge(makeDesktopWindowLayer(closeMainForShutdown, activate)),
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
  it.effect(
    "cancelling quit leaves the window and backend alive, then permits a fresh attempt",
    () =>
      Effect.gen(function* () {
        const events = new NodeEvents.EventEmitter();
        const finished = yield* Deferred.make<void>();
        let confirm = false;
        let checks = 0;
        let closes = 0;
        const app = makeElectronApp({
          on: (name, listener) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                events.on(name, listener);
              }),
              () =>
                Effect.sync(() => {
                  events.removeListener(name, listener);
                }),
            ).pipe(Effect.asVoid),
        });
        yield* Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          const state = yield* DesktopState.DesktopState;
          const shutdown = yield* DesktopShutdown.DesktopShutdown;
          yield* lifecycle.register;
          events.emit("before-quit", { preventDefault: () => undefined });
          assert.equal(checks, 1);
          assert.equal(closes, 0);
          assert.isFalse(yield* Ref.get(state.quitting));
          confirm = true;
          events.emit("before-quit", { preventDefault: () => undefined });
          events.emit("before-quit", { preventDefault: () => undefined });
          yield* shutdown.awaitRequest;
          assert.equal(checks, 2);
          assert.equal(closes, 1);
          yield* shutdown.markComplete;
          yield* Deferred.await(finished);
        }).pipe(
          Effect.provide(
            makeLifecycleLayer(
              "win32",
              app,
              Effect.void,
              Effect.sync(() => {
                closes++;
              }),
              Effect.void,
              Effect.void,
              Deferred.succeed(finished, undefined).pipe(Effect.as(true)),
              Effect.sync(() => {
                checks++;
                return confirm;
              }),
            ),
          ),
        );
      }),
  );

  it.effect("keeps a late window close from exiting before the update handoff", () =>
    Effect.gen(function* () {
      const events = new NodeEvents.EventEmitter();
      const installed = yield* Deferred.make<void>();
      let prematureQuit = false;
      const electronApp = makeElectronApp({
        on: (eventName, listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              events.on(eventName, listener);
            }),
            () =>
              Effect.sync(() => {
                events.removeListener(eventName, listener);
              }),
          ).pipe(Effect.asVoid),
        once: (eventName, listener) =>
          Effect.sync(() => {
            events.once(eventName, listener);
          }),
      });
      yield* Effect.gen(function* () {
        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        const shutdown = yield* DesktopShutdown.DesktopShutdown;
        const listenerScope = yield* Scope.make();
        yield* lifecycle.register.pipe(Scope.provide(listenerScope));
        events.emit("before-quit", { preventDefault: () => undefined });
        yield* shutdown.awaitRequest;
        yield* Scope.close(listenerScope, Exit.void);
        // Electron defaults to quitting when this event has no subscribers.
        // Native delivery can follow the removal of the scoped app listeners.
        prematureQuit = !events.emit("window-all-closed");
        yield* shutdown.markComplete;
        yield* Deferred.await(installed);
        assert.isFalse(prematureQuit);
      }).pipe(
        Effect.provide(
          makeLifecycleLayer(
            "darwin",
            electronApp,
            Effect.void,
            Effect.void,
            Effect.void,
            Effect.void,
            Deferred.succeed(installed, undefined).pipe(Effect.as(true)),
          ),
        ),
      );
    }),
  );

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

  for (const updaterOwnsQuit of [false, true]) {
    it.effect(`waits for cleanup before final quit (updater handoff: ${updaterOwnsQuit})`, () =>
      Effect.gen(function* () {
        const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
        const finalQuit = yield* Deferred.make<void>();
        let installCount = 0;
        let quitCount = 0;
        const installOnQuit = Effect.gen(function* () {
          installCount += 1;
          if (updaterOwnsQuit) yield* Deferred.succeed(finalQuit, undefined);
          return updaterOwnsQuit;
        });
        const electronApp = makeElectronApp({
          on: (eventName, listener) =>
            Effect.sync(() => {
              appListeners.set(
                eventName,
                listener as unknown as (...args: readonly unknown[]) => void,
              );
            }),
          quit: Effect.sync(() => {
            quitCount += 1;
            let prevented = false;
            appListeners.get("before-quit")?.({
              preventDefault: () => {
                prevented = true;
              },
            });
            assert.isFalse(prevented);
          }).pipe(Effect.andThen(Deferred.succeed(finalQuit, undefined)), Effect.asVoid),
        });

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
            });
            yield* shutdown.awaitRequest;
            assert.isTrue(prevented);
            assert.isFalse(yield* Deferred.isDone(finalQuit));
            assert.equal(installCount, 0);
            yield* shutdown.markComplete;
            yield* Deferred.await(finalQuit);
            assert.equal(installCount, 1);
            assert.equal(quitCount, updaterOwnsQuit ? 0 : 1);
          }),
        ).pipe(
          Effect.provide(
            makeLifecycleLayer(
              "win32",
              electronApp,
              Effect.void,
              Effect.void,
              Effect.void,
              Effect.void,
              installOnQuit,
            ),
          ),
        );
      }),
    );
  }

  it.effect("closes the main window before requesting application cleanup", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const closeStarted = yield* Deferred.make<void>();
      const allowClose = yield* Deferred.make<void>();
      const remainingWindowsDestroyed = yield* Deferred.make<void>();
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
          assert.isFalse(yield* Deferred.isDone(remainingWindowsDestroyed));

          yield* Deferred.succeed(allowClose, undefined);
          yield* Deferred.await(remainingWindowsDestroyed);
          yield* Deferred.await(shutdownObserved);
          yield* Fiber.join(shutdownRequested);
          yield* shutdown.markComplete;
        }),
      ).pipe(
        Effect.provide(
          makeLifecycleLayer(
            "darwin",
            electronApp,
            Effect.void,
            closeMainForShutdown,
            Deferred.succeed(remainingWindowsDestroyed, undefined).pipe(Effect.asVoid),
          ),
        ),
      );
    }),
  );

  it.effect("ignores app activation while quitting", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      let activationCount = 0;
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
      const activate = Effect.sync(() => {
        activationCount += 1;
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          const state = yield* DesktopState.DesktopState;
          yield* lifecycle.register;
          yield* Ref.set(state.quitting, true);

          appListeners.get("activate")?.();
          yield* Effect.yieldNow;

          assert.equal(activationCount, 0);
        }),
      ).pipe(
        Effect.provide(
          makeLifecycleLayer(
            "darwin",
            electronApp,
            Effect.void,
            Effect.void,
            Effect.void,
            activate,
          ),
        ),
      );
    }),
  );
});
