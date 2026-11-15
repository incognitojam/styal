import type { DesktopUpdateState } from "@t3tools/contracts";
import { idleRestartBlocked } from "@t3tools/shared/hostActivity";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopShutdownGuard from "../app/DesktopShutdownGuard.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";

const IDLE_RESTART_POLL_INTERVAL = "30 seconds";
const IDLE_RESTART_IDLE_SECONDS = 300;
// Idle eligibility never authorizes an automatic install.
const IDLE_RESTART_INSTALLS = false;
// Preserve the staged-version file lifecycle across restarts.
const IDLE_RESTART_PENDING_FILE = "update-idle-restart-pending";

const { logWarning } = DesktopObservability.makeComponentLogger("desktop-updater");

/** Track staged-update idle eligibility locally without installing an update. */
export const make = Effect.fn("desktop.updates.makeIdleRestart")(function* (options: {
  readonly runtimeDir: string;
  readonly updateState: Effect.Effect<DesktopUpdateState>;
  readonly updateActionActive: Effect.Effect<boolean>;
  readonly install: (version: string) => Effect.Effect<unknown>;
}) {
  const guard = yield* DesktopShutdownGuard.DesktopShutdownGuard;
  const desktopState = yield* DesktopState.DesktopState;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;

  // Set only while the update is staged: start follows staging, and a
  // discard clears it through abandon.
  const pendingRef = yield* Ref.make<{ readonly version: string } | undefined>(undefined);
  const reported = new Set<string>();
  const pendingPath = environment.path.join(options.runtimeDir, IDLE_RESTART_PENDING_FILE);

  const report = Effect.fn("desktop.updates.reportIdleRestart")(function* (version: string) {
    reported.add(version);

    yield* fileSystem.remove(pendingPath, { force: true }).pipe(Effect.ignore);
  });

  const userIsAway = powerMonitor
    .getSystemIdleState(IDLE_RESTART_IDLE_SECONDS)
    .pipe(Effect.map((state) => state === "idle" || state === "locked"));

  // The pending update, while it is still the downloaded update and no update
  // action or quit is under way.
  const candidate = Effect.gen(function* () {
    const pending = yield* Ref.get(pendingRef);
    if (
      pending === undefined ||
      (yield* Ref.get(desktopState.quitting)) ||
      (yield* options.updateActionActive)
    ) {
      return undefined;
    }
    const state = yield* options.updateState;
    return state.status === "downloaded" && state.downloadedVersion === pending.version
      ? pending
      : undefined;
  });

  // Runs when an idle restart would install the staged update.
  const restartWhileIdle = Effect.fn("desktop.updates.restartWhileIdle")(function* (pending: {
    readonly version: string;
  }) {
    yield* Ref.set(pendingRef, undefined);
    yield* report(pending.version);
    if (IDLE_RESTART_INSTALLS) yield* options.install(pending.version);
  });

  const check = Effect.gen(function* () {
    if ((yield* candidate) === undefined || !(yield* userIsAway)) return;
    if (idleRestartBlocked(yield* guard.inspect)) return;
    // The inspection takes a moment; the user or an update action may be back.
    const pending = yield* candidate;
    if (pending === undefined || !(yield* userIsAway)) return;
    yield* restartWhileIdle(pending);
  }).pipe(Effect.withSpan("desktop.updates.checkIdleRestart"));

  return {
    /** Tracks the staged update until its first idle moment. */
    start: Effect.fn("desktop.updates.startIdleRestart")(function* (version: string) {
      if (reported.has(version)) return;
      // Written before the candidate is visible to the idle check, so a
      // report cannot remove the file before this write recreates it.
      yield* fileSystem
        .makeDirectory(options.runtimeDir, { recursive: true })
        .pipe(Effect.andThen(fileSystem.writeFileString(pendingPath, version)), Effect.ignore);
      yield* Ref.set(pendingRef, { version });
    }),

    /** A staged download that is discarded before an idle moment never had one. */
    abandon: Ref.getAndSet(pendingRef, undefined).pipe(
      Effect.flatMap((pending) => (pending === undefined ? Effect.void : report(pending.version))),
    ),

    /** Clears the previous staged-version record and starts idle checks on macOS. */
    startChecks: Effect.gen(function* () {
      if (environment.platform !== "darwin") return;
      const unreported = yield* fileSystem.readFileString(pendingPath).pipe(
        Effect.map((version) => version.trim()),
        Effect.orElseSucceed(() => ""),
      );
      if (unreported !== "") {
        yield* report(unreported);
      }
      yield* Effect.sleep(IDLE_RESTART_POLL_INTERVAL).pipe(
        Effect.andThen(check),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => logWarning("idle restart check failed", { cause }),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
    }),
  };
});
