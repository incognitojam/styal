import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type * as Electron from "electron";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopObservability from "./DesktopObservability.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

export class DesktopLifecycleRelaunchError extends Schema.TaggedErrorClass<DesktopLifecycleRelaunchError>()(
  "DesktopLifecycleRelaunchError",
  {
    reason: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop relaunch failed for reason "${this.reason}".`;
  }
}

export type DesktopLifecycleRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopObservability.DesktopTrace
  | DesktopShutdown.DesktopShutdown
  | DesktopState.DesktopState
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp
  | ElectronTheme.ElectronTheme;

type DesktopLifecycleRegistrationServices =
  | DesktopLifecycleRuntimeServices
  | ElectronWindow.ElectronWindow;

/**
 * @effect-expect-leaking DesktopEnvironment | DesktopShutdown | DesktopState | DesktopTrace | DesktopWindow | ElectronApp | ElectronTheme | ElectronWindow
 */
export class DesktopLifecycle extends Context.Service<
  DesktopLifecycle,
  {
    readonly relaunch: (
      reason: string,
    ) => Effect.Effect<void, never, DesktopLifecycleRuntimeServices>;
    readonly register: Effect.Effect<
      void,
      never,
      Scope.Scope | DesktopLifecycleRegistrationServices
    >;
  }
>()("@t3tools/desktop/app/DesktopLifecycle") {}

const { logInfo: logLifecycleInfo, logError: logLifecycleError } =
  DesktopObservability.makeComponentLogger("desktop-lifecycle");

function addScopedListener<Args extends ReadonlyArray<unknown>>(
  target: unknown,
  eventName: string,
  listener: (...args: Args) => void,
): Effect.Effect<void, never, Scope.Scope> {
  const eventTarget = target as {
    on: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
    removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
  };
  const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
  return Effect.acquireRelease(
    Effect.sync(() => {
      eventTarget.on(eventName, untypedListener);
    }),
    () =>
      Effect.sync(() => {
        eventTarget.removeListener(eventName, untypedListener);
      }),
  ).pipe(Effect.asVoid);
}

const requestDesktopShutdownAndWait = Effect.fn("desktop.lifecycle.requestShutdownAndWait")(
  function* (
    afterMainWindowClose: Effect.Effect<void> = Effect.void,
  ): Effect.fn.Return<
    number,
    never,
    DesktopShutdown.DesktopShutdown | DesktopWindow.DesktopWindow
  > {
    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const shutdownStartedAt = yield* Clock.currentTimeMillis;
    yield* logLifecycleInfo("desktop shutdown requested");
    yield* desktopWindow.flushMainWindowBounds;
    yield* logLifecycleInfo("desktop shutdown window bounds flushed", {
      elapsedMs: (yield* Clock.currentTimeMillis) - shutdownStartedAt,
    });
    yield* desktopWindow.closeMainForShutdown;
    yield* logLifecycleInfo("desktop shutdown main window closed", {
      elapsedMs: (yield* Clock.currentTimeMillis) - shutdownStartedAt,
    });
    yield* afterMainWindowClose;
    yield* shutdown.request;
    yield* logLifecycleInfo("desktop shutdown waiting for application cleanup", {
      elapsedMs: (yield* Clock.currentTimeMillis) - shutdownStartedAt,
    });
    yield* shutdown.awaitComplete.pipe(Effect.withSpan("desktop.lifecycle.awaitShutdownComplete"));
    yield* logLifecycleInfo("desktop shutdown application cleanup complete", {
      elapsedMs: (yield* Clock.currentTimeMillis) - shutdownStartedAt,
    });
    return shutdownStartedAt;
  },
);

const recordQuitMilestone = Effect.fnUntraced(function* (
  phase: "requesting-electron-quit" | "electron-quit-request-returned" | "electron-will-quit",
  message: string,
  shutdownStartedAt: number | undefined,
) {
  const now = yield* Clock.currentTimeMillis;
  const timing =
    shutdownStartedAt === undefined
      ? { shutdownStartedAtKnown: false }
      : { shutdownStartedAtKnown: true, elapsedMs: now - shutdownStartedAt };
  yield* logLifecycleInfo(message, timing).pipe(
    Effect.withSpan("desktop.lifecycle.quitMilestone", {
      attributes: { phase, ...timing },
    }),
  );
  yield* DesktopObservability.flushTrace;
});

const quitElectronAfterShutdown = Effect.fn("desktop.lifecycle.quitElectronAfterShutdown")(
  function* (
    shutdownStartedAt: number | undefined,
    runSync: <A, E>(effect: Effect.Effect<A, E, DesktopLifecycleRuntimeServices>) => A,
  ) {
    const electronApp = yield* ElectronApp.ElectronApp;
    yield* electronApp.once("will-quit", () => {
      runSync(recordQuitMilestone("electron-will-quit", "Electron will quit", shutdownStartedAt));
    });
    yield* recordQuitMilestone(
      "requesting-electron-quit",
      "requesting Electron quit",
      shutdownStartedAt,
    );
    yield* electronApp.quit;
    yield* recordQuitMilestone(
      "electron-quit-request-returned",
      "Electron quit request returned",
      shutdownStartedAt,
    );
  },
);

function handleBeforeQuit(
  event: Electron.Event,
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, DesktopLifecycleRegistrationServices>,
  ) => Promise<A>,
  runSync: <A, E>(effect: Effect.Effect<A, E, DesktopLifecycleRuntimeServices>) => A,
  allowQuit: () => boolean,
  markQuitAllowed: () => void,
): void {
  if (allowQuit()) {
    void runEffect(
      Effect.gen(function* () {
        const state = yield* DesktopState.DesktopState;
        yield* Ref.set(state.quitting, true);
        yield* logLifecycleInfo("before-quit received");
      }).pipe(Effect.withSpan("desktop.lifecycle.beforeQuit")),
    );
    return;
  }

  event.preventDefault();
  let shutdownStartedAt: number | undefined;
  const shutdownEffect = Effect.gen(function* () {
    const state = yield* DesktopState.DesktopState;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    yield* Ref.set(state.quitting, true);
    yield* logLifecycleInfo("before-quit received");
    shutdownStartedAt = yield* requestDesktopShutdownAndWait(
      electronWindow.destroyAll.pipe(
        Effect.catchCause((cause) =>
          logLifecycleError("failed to destroy remaining windows before shutdown", { cause }),
        ),
      ),
    );
  }).pipe(Effect.withSpan("desktop.lifecycle.beforeQuit"));
  void runEffect(Effect.andThen(shutdownEffect, DesktopObservability.flushTrace)).finally(() => {
    markQuitAllowed();
    void runEffect(
      quitElectronAfterShutdown(shutdownStartedAt, runSync).pipe(
        Effect.andThen(DesktopObservability.flushTrace),
      ),
    );
  });
}

function quitFromSignal(
  signal: "SIGINT" | "SIGTERM",
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, DesktopLifecycleRegistrationServices>,
  ) => Promise<A>,
  runSync: <A, E>(effect: Effect.Effect<A, E, DesktopLifecycleRuntimeServices>) => A,
  markQuitAllowed: () => void,
): void {
  void runEffect(
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ signal });
      const state = yield* DesktopState.DesktopState;
      const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
      if (wasQuitting) return;
      yield* logLifecycleInfo("process signal received", { signal });
      const shutdownStartedAt = yield* requestDesktopShutdownAndWait();
      markQuitAllowed();
      yield* quitElectronAfterShutdown(shutdownStartedAt, runSync);
    }).pipe(
      Effect.withSpan("desktop.lifecycle.processSignal"),
      Effect.andThen(DesktopObservability.flushTrace),
    ),
  );
}

export const make = DesktopLifecycle.of({
  relaunch: Effect.fn("desktop.lifecycle.relaunch")(function* (reason) {
    const electronApp = yield* ElectronApp.ElectronApp;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const state = yield* DesktopState.DesktopState;
    yield* logLifecycleInfo("desktop relaunch requested", { reason });
    yield* Effect.gen(function* () {
      yield* Effect.yieldNow;
      yield* Ref.set(state.quitting, true);
      yield* requestDesktopShutdownAndWait();
      yield* DesktopObservability.flushTrace;
      if (environment.isDevelopment) {
        yield* electronApp.exit(75);
        return;
      }
      yield* electronApp.relaunch({
        execPath: process.execPath,
        args: process.argv.slice(1),
      });
      yield* electronApp.exit(0);
    }).pipe(
      Effect.catchCause((cause) => {
        const error = new DesktopLifecycleRelaunchError({ reason, cause });
        return logLifecycleError(error.message, { error });
      }),
      Effect.forkDetach,
      Effect.asVoid,
    );
  }),
  register: Effect.gen(function* () {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const electronApp = yield* ElectronApp.ElectronApp;
    const electronTheme = yield* ElectronTheme.ElectronTheme;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const context = yield* Effect.context<DesktopLifecycleRegistrationServices>();
    const runEffect = Effect.runPromiseWith(context);
    const runSync = Effect.runSyncWith(context);
    let quitAllowed = false;
    let updaterQuitAllowed = false;
    yield* electronTheme.onUpdated(() => {
      void runEffect(
        desktopWindow.syncAppearance.pipe(Effect.withSpan("desktop.lifecycle.themeUpdated")),
      );
    });
    yield* electronApp.onBeforeQuitForUpdate(() => {
      // Electron's updater owns the remaining quit/install/relaunch sequence.
      // Cancelling the following app "before-quit" event breaks that sequence,
      // most visibly on macOS where the native updater performs the relaunch.
      updaterQuitAllowed = true;
      void runEffect(
        logLifecycleInfo("allowing updater-controlled quit").pipe(
          Effect.withSpan("desktop.lifecycle.beforeQuitForUpdate"),
        ),
      );
    });
    yield* electronApp.on("before-quit", (event: Electron.Event) => {
      handleBeforeQuit(
        event,
        runEffect,
        runSync,
        () => quitAllowed || updaterQuitAllowed,
        () => {
          quitAllowed = true;
        },
      );
    });
    yield* electronApp.on("activate", () => {
      void runEffect(
        Effect.gen(function* () {
          const state = yield* DesktopState.DesktopState;
          if (yield* Ref.get(state.quitting)) return;
          yield* desktopWindow.activate;
        }).pipe(Effect.withSpan("desktop.lifecycle.activate")),
      );
    });
    yield* electronApp.on("window-all-closed", () => {
      void runEffect(
        Effect.gen(function* () {
          const app = yield* ElectronApp.ElectronApp;
          const state = yield* DesktopState.DesktopState;
          if (environment.platform !== "darwin" && !(yield* Ref.get(state.quitting))) {
            yield* app.quit;
          }
        }).pipe(Effect.withSpan("desktop.lifecycle.windowAllClosed")),
      );
    });

    if (environment.platform !== "win32") {
      yield* addScopedListener(process, "SIGINT", () => {
        quitFromSignal("SIGINT", runEffect, runSync, () => {
          quitAllowed = true;
        });
      });
      yield* addScopedListener(process, "SIGTERM", () => {
        quitFromSignal("SIGTERM", runEffect, runSync, () => {
          quitAllowed = true;
        });
      });
    }
  }).pipe(Effect.withSpan("desktop.lifecycle.register")),
});

export const layer = Layer.succeed(DesktopLifecycle, make);
