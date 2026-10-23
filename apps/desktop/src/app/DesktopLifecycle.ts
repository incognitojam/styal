import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type * as Electron from "electron";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopObservability from "./DesktopObservability.ts";
import * as DesktopShutdownGuard from "./DesktopShutdownGuard.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

export class DesktopLifecycleRelaunchError extends Schema.TaggedError<DesktopLifecycleRelaunchError>()(
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
  | DesktopShutdownGuard.DesktopShutdownGuard
  | DesktopEnvironment.DesktopEnvironment
  | DesktopObservability.DesktopTrace
  | DesktopShutdown.DesktopShutdown
  | DesktopState.DesktopState
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp
  | ElectronTheme.ElectronTheme;

type DesktopLifecycleRegistrationServices =
  | DesktopLifecycleRuntimeServices
  | ElectronWindow.ElectronWindow
  | DesktopUpdates.DesktopUpdates;

/**
 * @effect-expect-leaking DesktopShutdownGuard | DesktopEnvironment | DesktopShutdown | DesktopState | DesktopTrace | DesktopUpdates | DesktopWindow | ElectronApp | ElectronTheme | ElectronWindow
 */
export class DesktopLifecycle extends Context.Service<
  DesktopLifecycle,
  {
    /** Pass `continueThreads: false` when the relaunch turns off or replaces a backend. */
    readonly relaunch: (
      reason: string,
      options?: { readonly continueThreads?: boolean },
    ) => Effect.Effect<boolean, never, DesktopLifecycleRuntimeServices>;
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
    DesktopShutdown.DesktopShutdown | DesktopWindow.DesktopWindow | ElectronApp.ElectronApp
  > {
    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const electronApp = yield* ElectronApp.ElectronApp;
    // The final window-all-closed event can arrive after cleanup removes the
    // scoped listeners. Without a listener Electron quits immediately, before
    // the updater can stage its installer. Keep this last close under our control.
    yield* electronApp.once("window-all-closed", () => {});
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
    runEffect: <A, E>(effect: Effect.Effect<A, E, DesktopLifecycleRuntimeServices>) => Promise<A>,
  ) {
    const electronApp = yield* ElectronApp.ElectronApp;
    yield* electronApp.once("will-quit", () => {
      // Trace writes can yield. Electron does not wait for this final diagnostic flush.
      void runEffect(
        recordQuitMilestone("electron-will-quit", "Electron will quit", shutdownStartedAt).pipe(
          Effect.catchCause((cause) =>
            logLifecycleError("failed to record Electron will-quit milestone", { cause }),
          ),
        ),
      );
    });
    yield* recordQuitMilestone(
      "requesting-electron-quit",
      "requesting Electron quit",
      shutdownStartedAt,
    );
    const updates = yield* DesktopUpdates.DesktopUpdates;
    if (yield* updates.installOnQuit) return;
    yield* electronApp.quit;
    yield* recordQuitMilestone(
      "electron-quit-request-returned",
      "Electron quit request returned",
      shutdownStartedAt,
    );
  },
);

interface QuitState {
  phase: "running" | "waiting" | "allowed";
  waitingSinceNanos: bigint;
}

// Longer than a backend's stop budget (SIGTERM, 5s grace, SIGKILL, 1s wait),
// so a double Cmd-Q at the start of a normal quit cannot cut the backend stop
// short and orphan it.
const SHUTDOWN_STALL_THRESHOLD = Duration.seconds(10);

const startWaitingForShutdown = Effect.fn("desktop.lifecycle.startWaitingForShutdown")(function* (
  quit: QuitState,
) {
  quit.phase = "waiting";
  quit.waitingSinceNanos = yield* Clock.monotonicTimeNanos;
});

// While a quit waits on shutdown, `quitting` makes activation open nothing. If
// that shutdown stalls, a repeated Quit or SIGTERM is the user's only way out
// short of SIGKILL.
const exitIfShutdownStalled = Effect.fn("desktop.lifecycle.exitIfShutdownStalled")(function* (
  quit: QuitState,
  source: string,
) {
  const pendingMs = Number(
    ((yield* Clock.monotonicTimeNanos) - quit.waitingSinceNanos) / 1_000_000n,
  );
  if (pendingMs < Duration.toMillis(SHUTDOWN_STALL_THRESHOLD)) {
    yield* logLifecycleInfo("quit already in progress", { source, pendingMs });
    return;
  }
  yield* logLifecycleError("desktop shutdown stalled; exiting without it", { source, pendingMs });
  const electronApp = yield* ElectronApp.ElectronApp;
  yield* electronApp.exit(0);
});

function handleBeforeQuit(
  event: Electron.Event,
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, DesktopLifecycleRegistrationServices>,
  ) => Promise<A>,
  quit: QuitState,
): void {
  if (quit.phase === "allowed") {
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
  if (quit.phase === "waiting") {
    void runEffect(exitIfShutdownStalled(quit, "before-quit"));
    return;
  }
  let shutdownStartedAt: number | undefined;
  const shutdownEffect = Effect.gen(function* () {
    const state = yield* DesktopState.DesktopState;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    yield* startWaitingForShutdown(quit);
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
    quit.phase = "allowed";
    void runEffect(
      quitElectronAfterShutdown(shutdownStartedAt, runEffect).pipe(
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
  quit: QuitState,
): void {
  if (quit.phase === "waiting") {
    void runEffect(exitIfShutdownStalled(quit, signal));
    return;
  }
  void runEffect(
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ signal });
      const state = yield* DesktopState.DesktopState;
      const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
      if (wasQuitting) return;
      yield* startWaitingForShutdown(quit);
      yield* logLifecycleInfo("process signal received", { signal });
      const shutdownStartedAt = yield* requestDesktopShutdownAndWait();
      quit.phase = "allowed";
      yield* quitElectronAfterShutdown(shutdownStartedAt, runEffect);
    }).pipe(
      Effect.withSpan("desktop.lifecycle.processSignal"),
      Effect.andThen(DesktopObservability.flushTrace),
    ),
  );
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = DesktopLifecycle.of({
  relaunch: Effect.fn("desktop.lifecycle.relaunch")(function* (reason, options) {
    const electronApp = yield* ElectronApp.ElectronApp;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const state = yield* DesktopState.DesktopState;
    if (yield* Ref.get(state.quitting)) return false;
    const guard = yield* DesktopShutdownGuard.DesktopShutdownGuard;
    if (!(yield* guard.confirm("restart", options))) return false;
    yield* logLifecycleInfo("desktop relaunch requested", { reason });
    yield* Ref.set(state.quitting, true);
    return yield* Effect.gen(function* () {
      yield* Effect.yieldNow;
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
      Effect.as(true),
    );
  }),
  register: Effect.gen(function* () {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const electronApp = yield* ElectronApp.ElectronApp;
    const electronTheme = yield* ElectronTheme.ElectronTheme;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const context = yield* Effect.context<DesktopLifecycleRegistrationServices>();
    const runEffect = Effect.runPromiseWith(context);
    const quit: QuitState = { phase: "running", waitingSinceNanos: 0n };
    let quitCheckPending = false;
    yield* electronTheme.onUpdated(() => {
      void runEffect(
        desktopWindow.syncAppearance.pipe(Effect.withSpan("desktop.lifecycle.themeUpdated")),
      );
    });
    yield* electronApp.onBeforeQuitForUpdate(() => {
      // Electron's updater owns the remaining quit/install/relaunch sequence.
      // Cancelling the following app "before-quit" event breaks that sequence,
      // most visibly on macOS where the native updater performs the relaunch.
      quit.phase = "allowed";
      // This event is synchronous and the updater's quit proceeds as soon as
      // the listener returns, so a forked destroyAll would race the quit
      // and windows could still be open when the process exits (visible on
      // macOS). Destroy them inline.
      Effect.runSyncWith(context)(
        electronWindow.destroyAll.pipe(
          Effect.andThen(logLifecycleInfo("allowing updater-controlled quit")),
          Effect.catchCause((cause) =>
            logLifecycleError("failed to destroy windows before updater quit", { cause }),
          ),
          Effect.withSpan("desktop.lifecycle.beforeQuitForUpdate"),
        ),
      );
    });
    yield* electronApp.on("before-quit", (event: Electron.Event) => {
      if (quit.phase !== "running") {
        handleBeforeQuit(event, runEffect, quit);
        return;
      }
      event.preventDefault();
      if (quitCheckPending) return;
      quitCheckPending = true;
      void runEffect(
        Effect.gen(function* () {
          const state = yield* DesktopState.DesktopState;
          if (yield* Ref.get(state.quitting)) {
            quitCheckPending = false;
            return;
          }
          const guard = yield* DesktopShutdownGuard.DesktopShutdownGuard;
          if (!(yield* guard.confirm("quit"))) {
            quitCheckPending = false;
            return;
          }
          handleBeforeQuit(event, runEffect, quit);
        }),
      ).catch(() => {
        quitCheckPending = false;
      });
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
        quitFromSignal("SIGINT", runEffect, quit);
      });
      yield* addScopedListener(process, "SIGTERM", () => {
        quitFromSignal("SIGTERM", runEffect, quit);
      });
    }
  }).pipe(Effect.withSpan("desktop.lifecycle.register")),
});

export const layer = Layer.succeed(DesktopLifecycle, make);
