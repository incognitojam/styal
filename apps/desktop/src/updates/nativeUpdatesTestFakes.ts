import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type * as DesktopShutdownGuard from "../app/DesktopShutdownGuard.ts";
import * as ElectronNativeUpdater from "../electron/ElectronNativeUpdater.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";

/** Legacy ShipIt cleanup and host activity for updater tests. */
export interface NativeUpdatesFakeOptions {
  readonly inheritedNativeJobActive?: boolean;
  readonly nativeStageUnavailable?: () => boolean;
  readonly nativeStageWait?: Effect.Effect<void>;
  readonly afterNativeDiscard?: Effect.Effect<void>;
  readonly inspectNativeUpdateFailure?: boolean;
  readonly discardNativeUpdateFailure?: "job-removal";
  /** A ShipIt job and request left by an earlier process. */
  readonly inheritedShipItRequest?: string;
}

/** A host with nothing that blocks or needs confirming. */
const quietHost = {
  activeSessions: 0,
  continuableSessions: 0,
  waitingSessions: 0,
  terminalsRequiringConfirmation: 0,
  terminalsWithUnknownActivity: 0,
  environmentsUsingDevices: 0,
} satisfies DesktopShutdownGuard.ActivityCheck;

export function makeNativeUpdatesFakes(options: NativeUpdatesFakeOptions) {
  const activity = {
    hosts: [quietHost] as ReadonlyArray<DesktopShutdownGuard.ActivityCheck>,
    inspections: 0,
    onInspect: undefined as (() => void) | undefined,
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
    stage: (options.nativeStageWait ?? Effect.void).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          squirrel.stageCount += 1;
          if (options.nativeStageUnavailable?.())
            return Effect.fail(
              new ElectronNativeUpdater.ElectronNativeUpdaterError({
                operation: "stage",
                cause: new Error("Squirrel.Mac found no update to stage."),
              }),
            );
          stageFromFeed();
          return Effect.void;
        }),
      ),
    ),
    discard: (discardOptions) =>
      Effect.suspend(() => {
        squirrel.discardCount += 1;
        if (
          options.inspectNativeUpdateFailure ||
          (squirrel.job && options.inheritedNativeJobActive && !discardOptions?.ownStaged) ||
          options.discardNativeUpdateFailure === "job-removal"
        ) {
          return Effect.fail(
            new ElectronNativeUpdater.ElectronNativeUpdaterError({
              operation: "discard",
              cause: new Error("launchctl remove failed"),
            }),
          );
        }
        squirrel.job = false;
        return Effect.void;
      }).pipe(
        Effect.andThen(
          discardOptions?.ownStaged ? (options.afterNativeDiscard ?? Effect.void) : Effect.void,
        ),
      ),
  } satisfies ElectronNativeUpdater.ElectronNativeUpdater["Service"]);

  const layerTelemetry = Layer.succeed(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {
    latest: Effect.succeedNone,
    changes: Stream.empty,
    encoded: Stream.empty,
    handleControlForSource: () => Effect.void,
    removeControlSource: () => Effect.void,
    publishUpdateReport: () => Effect.void,
    publishUpdateActivity: () => Effect.void,
    updateActivityRequests: Stream.empty,
    updateRequests: Stream.empty,
    updateCommits: Stream.empty,
    updateCancellations: Stream.empty,
  } satisfies DesktopTelemetryPublisher.DesktopTelemetryPublisher["Service"]);

  return {
    squirrel,
    activity,
    layer: Layer.mergeAll(layerNativeUpdater, layerTelemetry),
    inspect: Effect.sync(() => {
      activity.inspections += 1;
      activity.onInspect?.();
      return activity.hosts;
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
  };
}
