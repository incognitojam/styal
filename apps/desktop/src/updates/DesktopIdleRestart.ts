import type { DesktopIdleRestartDelayBucket, DesktopUpdateState } from "@t3tools/contracts";
import { idleRestartBlocked } from "@t3tools/shared/hostActivity";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopShutdownGuard from "../app/DesktopShutdownGuard.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";

const IDLE_RESTART_POLL_INTERVAL = "30 seconds";
const IDLE_RESTART_IDLE_SECONDS = 300;
// Measure-only: an eligible idle moment is recorded but nothing installs. Set
// to true to install the staged update at that moment.
const IDLE_RESTART_INSTALLS = false;
// Holds the staged version until an idle moment is recorded, so a quit or a
// replaced download before then is reported as "never" by the next launch.
const IDLE_RESTART_PENDING_FILE = "update-idle-restart-pending";

const { logWarning } = DesktopObservability.makeComponentLogger("desktop-updater");

/** Buckets the time from an update finishing staging to the first idle moment. */
export function idleRestartDelayBucket(
  delayMs: number,
): Exclude<DesktopIdleRestartDelayBucket, "installed_first" | "never"> {
  const hours = delayMs / 3_600_000;
  return hours < 1 ? "<1h" : hours < 8 ? "1-8h" : hours < 24 ? "8-24h" : ">24h";
}

/**
 * Idle restart for DesktopUpdates, macOS only. A staged update installs in a
 * few seconds, so it can install while the user is away. Today this only
 * measures how soon such a moment comes: once per staged version, it reports
 * the delay bucket.
 */
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
  const telemetry = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;

  // Set only while the update is staged: start follows staging, and a
  // discard clears it through abandon.
  const pendingRef = yield* Ref.make<
    { readonly version: string; readonly stagedAt: number } | undefined
  >(undefined);
  const reported = new Set<string>();
  const pendingPath = environment.path.join(options.runtimeDir, IDLE_RESTART_PENDING_FILE);

  const report = Effect.fn("desktop.updates.reportIdleRestart")(function* (
    version: string,
    delayBucket: DesktopIdleRestartDelayBucket,
  ) {
    reported.add(version);
    yield* telemetry.publishFeatureUsage({
      version: 1,
      type: "desktopFeatureUsage",
      feature: "desktop-update-idle-restart",
      action: "would_restart",
      updateVersion: version,
      delayBucket,
    });
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
    readonly stagedAt: number;
  }) {
    yield* Ref.set(pendingRef, undefined);
    const delayMs = (yield* Clock.currentTimeMillis) - pending.stagedAt;
    yield* report(pending.version, idleRestartDelayBucket(delayMs));
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
    /** Starts measuring once an update has staged. */
    start: Effect.fn("desktop.updates.startIdleRestart")(function* (version: string) {
      if (reported.has(version)) return;
      const stagedAt = yield* Clock.currentTimeMillis;
      // Written before the candidate is visible to the idle check, so a
      // report cannot remove the file before this write recreates it.
      yield* fileSystem
        .makeDirectory(options.runtimeDir, { recursive: true })
        .pipe(Effect.andThen(fileSystem.writeFileString(pendingPath, version)), Effect.ignore);
      yield* Ref.set(pendingRef, { version, stagedAt });
    }),

    /** A staged download that is discarded before an idle moment never had one. */
    abandon: Ref.getAndSet(pendingRef, undefined).pipe(
      Effect.flatMap((pending) =>
        pending === undefined ? Effect.void : report(pending.version, "never"),
      ),
    ),

    /** Reports what happened to the previous run's update and starts the
        periodic idle check. macOS only. */
    startChecks: Effect.gen(function* () {
      if (environment.platform !== "darwin") return;
      // The previous run quit before an idle moment. On macOS a quit installs
      // the staged update, so running that version means it installed first.
      const unreported = yield* fileSystem.readFileString(pendingPath).pipe(
        Effect.map((version) => version.trim()),
        Effect.orElseSucceed(() => ""),
      );
      if (unreported !== "") {
        yield* report(
          unreported,
          unreported === environment.appVersion ? "installed_first" : "never",
        );
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
