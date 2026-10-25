import type { DesktopFeatureUsageReport } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type * as DesktopShutdownGuard from "../app/DesktopShutdownGuard.ts";
import * as ElectronNativeUpdater from "../electron/ElectronNativeUpdater.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as DesktopLaunchTiming from "../telemetry/DesktopLaunchTiming.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";

/** Fakes for macOS background staging and idle restart measurement, wired
    into the DesktopUpdates test harness by updatesTestHarness.ts. */
export interface NativeUpdatesFakeOptions {
  /** macOS: whether the app bundle can be staged without administrator rights.
      Off by default, which keeps staging at quit as before. */
  readonly stagesInBackground?: boolean;
  /** Runs when background staging starts, before its outcome. */
  readonly beforeNativeStageOutcome?: Effect.Effect<void>;
  /** Where Squirrel's staging fails: before writing ShipItState.plist (a
      download or signature failure), after it (ShipIt submission), or with
      no update (Squirrel's empty result, reported as update-not-available
      rather than an error). */
  readonly nativeStageFailure?: () =>
    | "before-request"
    | "after-request"
    | "not-available"
    | undefined;
  readonly discardNativeUpdateFailure?: "job-removal" | "request-removal";
  /** A ShipIt job and request left by an earlier process. */
  readonly inheritedShipItRequest?: string;
}

/** A host with nothing that blocks or needs confirming. */
export const quietHost = {
  activeSessions: 0,
  continuableSessions: 0,
  waitingSessions: 0,
  terminalsRequiringConfirmation: 0,
  terminalsWithUnknownActivity: 0,
  environmentsUsingDevices: 0,
} satisfies DesktopShutdownGuard.ActivityCheck;

type FileSystemOverrides = Pick<
  FileSystem.FileSystem,
  "readFileString" | "writeFileString" | "remove"
>;

export function makeNativeUpdatesFakes(
  options: NativeUpdatesFakeOptions,
  emit: (eventName: string, payload?: unknown) => void,
) {
  // Idle restart inputs, changed by tests between ticks. `onInspect` runs
  // during each activity inspection, before it returns `hosts`.
  const idleRestart = {
    idleState: "active" as ElectronPowerMonitor.ElectronIdleState,
    hosts: [quietHost] as ReadonlyArray<DesktopShutdownGuard.ActivityCheck>,
    inspections: 0,
    onInspect: undefined as (() => void) | undefined,
    reports: [] as DesktopFeatureUsageReport[],
    /** Contents of the pending file that outlives the process. */
    pendingFile: undefined as string | undefined,
  };
  // Squirrel.Mac (8d80880) under electron-updater 6.8.9: each setFeedURL makes a fresh native
  // updater that writes ShipItState.plist (`request`) and submits ShipIt once; ShipIt installs
  // `request` on exit. MacUpdater's `staged` flag is never reset, and quitAndInstall stages
  // first only while it is unset.
  const squirrel = {
    feedVersion: undefined as string | undefined,
    feedSubmitted: false,
    job: options.inheritedShipItRequest !== undefined,
    request: options.inheritedShipItRequest,
    staged: false,
    stageCount: 0,
    discardCount: 0,
    installedOnExit: [] as Array<string | undefined>,
  };
  const stageFromFeed = () => {
    squirrel.request = squirrel.feedVersion;
    if (!squirrel.feedSubmitted) {
      squirrel.feedSubmitted = true;
      squirrel.job = true;
    }
    squirrel.staged = true;
  };

  const layerNativeUpdater = Layer.succeed(ElectronNativeUpdater.ElectronNativeUpdater, {
    canStageInBackground: Effect.succeed(options.stagesInBackground ?? false),
    stage: Effect.sync(() => {
      squirrel.stageCount += 1;
    }).pipe(
      Effect.andThen(options.beforeNativeStageOutcome ?? Effect.void),
      Effect.andThen(
        Effect.suspend(() => {
          const failure = options.nativeStageFailure?.();
          if (failure === undefined) {
            stageFromFeed();
            return Effect.void;
          }
          if (failure === "after-request") {
            squirrel.request = squirrel.feedVersion;
          }
          // MacUpdater re-emits native errors to electron-updater listeners.
          if (failure !== "not-available") {
            emit("error", new Error("Squirrel.Mac staging failed"));
          }
          return Effect.fail(
            new ElectronNativeUpdater.ElectronNativeUpdaterError({
              operation: "stage",
              cause: new Error(`staging failed ${failure}`),
            }),
          );
        }),
      ),
    ),
    discard: Effect.suspend(() => {
      squirrel.discardCount += 1;
      if (options.discardNativeUpdateFailure === "job-removal") {
        return Effect.fail(
          new ElectronNativeUpdater.ElectronNativeUpdaterError({
            operation: "discard",
            cause: new Error("launchctl remove failed"),
          }),
        );
      }
      squirrel.job = false;
      // A request whose removal fails is left behind, which the adapter ignores.
      if (options.discardNativeUpdateFailure !== "request-removal") squirrel.request = undefined;
      return Effect.void;
    }),
  } satisfies ElectronNativeUpdater.ElectronNativeUpdater["Service"]);

  const layerPowerMonitor = Layer.succeed(ElectronPowerMonitor.ElectronPowerMonitor, {
    isOnBatteryPower: Effect.succeed(false),
    getSystemIdleTime: Effect.succeed(0),
    getSystemIdleState: () => Effect.sync(() => idleRestart.idleState),
    getCurrentThermalState: Effect.succeed("nominal"),
    onSimpleEvent: () => Effect.void,
    onThermalStateChange: () => Effect.void,
    onSpeedLimitChange: () => Effect.void,
  } satisfies ElectronPowerMonitor.ElectronPowerMonitor["Service"]);

  const layerTelemetry = Layer.succeed(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {
    latest: Effect.succeedNone,
    changes: Stream.empty,
    encoded: Stream.empty,
    handleControlForSource: () => Effect.void,
    removeControlSource: () => Effect.void,
    publishUpdateReport: () => Effect.void,
    publishUpdateActivity: () => Effect.void,
    updateActivityRequests: Stream.empty,
    publishFeatureUsage: (report) =>
      Effect.sync(() => {
        idleRestart.reports.push(report);
      }),
    updateRequests: Stream.empty,
    updateCommits: Stream.empty,
    updateCancellations: Stream.empty,
  } satisfies DesktopTelemetryPublisher.DesktopTelemetryPublisher["Service"]);

  // The idle restart pending file is kept apart from the harness's other files.
  const isIdleRestartFile = (path: string) => path.endsWith("update-idle-restart-pending");

  return {
    squirrel,
    idleRestart,
    layer: Layer.mergeAll(
      layerNativeUpdater,
      layerPowerMonitor,
      layerTelemetry,
      DesktopLaunchTiming.layerNoop,
    ),
    inspect: Effect.sync(() => {
      idleRestart.inspections += 1;
      idleRestart.onInspect?.();
      return idleRestart.hosts;
    }),
    /** Called for every event the harness emits. */
    onEmit: (eventName: string, payload?: unknown) => {
      if (eventName === "update-downloaded") {
        squirrel.feedVersion = (payload as { version: string }).version;
        squirrel.feedSubmitted = false;
      }
    },
    /** Called when electron-updater's quitAndInstall runs. */
    onQuitAndInstall: () => {
      if (!squirrel.staged) stageFromFeed();
      squirrel.installedOnExit.push(squirrel.job ? squirrel.request : undefined);
    },
    /** Serves the idle restart pending file from memory. */
    withIdleRestartFile: <T extends FileSystemOverrides>(fileSystem: T): T => ({
      ...fileSystem,
      readFileString: (path, encoding) =>
        isIdleRestartFile(path) && idleRestart.pendingFile !== undefined
          ? Effect.succeed(idleRestart.pendingFile)
          : fileSystem.readFileString(path, encoding),
      writeFileString: (path, contents, writeOptions) =>
        isIdleRestartFile(path)
          ? Effect.sync(() => {
              idleRestart.pendingFile = contents;
            })
          : fileSystem.writeFileString(path, contents, writeOptions),
      remove: (path, removeOptions) =>
        isIdleRestartFile(path)
          ? Effect.sync(() => {
              idleRestart.pendingFile = undefined;
            })
          : fileSystem.remove(path, removeOptions),
    }),
  };
}
