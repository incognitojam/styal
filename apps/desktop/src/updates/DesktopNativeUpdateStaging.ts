import { DesktopUpdateChannelSchema, type DesktopUpdateChannel } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronNativeUpdater from "../electron/ElectronNativeUpdater.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-updater");

export class DesktopUpdateStagedUpdateDiscardError extends Schema.TaggedError<DesktopUpdateStagedUpdateDiscardError>()(
  "DesktopUpdateStagedUpdateDiscardError",
  {
    requestedChannel: DesktopUpdateChannelSchema,
    cause: Schema.instanceOf(ElectronNativeUpdater.ElectronNativeUpdaterError),
  },
) {
  override get message(): string {
    return `Cannot change the desktop update channel to ${this.requestedChannel} because the update prepared for installation could not be discarded.`;
  }
}

type NativeStageStatus = "staging" | "staged" | "failed";

interface InstallFlags {
  readonly isSilent: boolean;
  readonly isForceRunAfter: boolean;
}

/**
 * macOS background staging for DesktopUpdates. Once Squirrel.Mac stages a
 * download, its ShipIt job installs it whenever the app exits. Checks continue
 * while it waits; a newer release discards it before downloading, so the
 * restart installs the latest build rather than the first one downloaded.
 * Staging cannot be cancelled, so the lock is held until Squirrel's own
 * terminal event; checks, the handoff and channel changes wait for it. On
 * other platforms every method leaves the updater's own behaviour in place.
 */
export const make = Effect.fn("desktop.updates.makeNativeUpdateStaging")(function* (options: {
  readonly enabled: boolean;
  readonly downloadedVersion: Effect.Effect<string | null>;
  readonly quitting: Effect.Effect<boolean>;
  readonly updaterConfigured: Effect.Effect<boolean>;
  /** Clears the download from the update state. */
  readonly clearDownload: Effect.Effect<void>;
  readonly onStaged: (version: string) => Effect.Effect<void>;
  readonly onDiscarded: Effect.Effect<void>;
}) {
  const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
  const nativeUpdater = yield* ElectronNativeUpdater.ElectronNativeUpdater;

  const nativeStageRef = yield* Ref.make<
    { readonly version: string; readonly status: NativeStageStatus } | undefined
  >(undefined);
  // The download Squirrel's native feed serves. MacUpdater sets a new feed,
  // and with it a fresh native updater, for every download of any channel.
  // Squirrel submits ShipIt once per native updater, so a feed is spent once
  // a discard removes the job.
  const nativeFeedRef = yield* Ref.make<
    { readonly version: string; readonly spent: boolean } | undefined
  >(undefined);
  const lock = yield* Semaphore.make(1);

  const setNativeStage = (version: string, status: NativeStageStatus) =>
    Ref.set(nativeStageRef, { version, status });

  // Stages from the current native feed and waits for Squirrel's own
  // completion or error. Callers hold the lock.
  const stageLocked = Effect.fn("desktop.updates.stageNativeUpdate")(function* (version: string) {
    yield* setNativeStage(version, "staging");
    const startedAt = yield* Clock.currentTimeMillis;
    const exit = yield* nativeUpdater.stage.pipe(Effect.exit);
    yield* setNativeStage(version, Exit.isSuccess(exit) ? "staged" : "failed");
    const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
    yield* Exit.isSuccess(exit)
      ? logInfo("staged update for installation", { version, elapsedMs })
      : logWarning("could not stage update", { version, elapsedMs, cause: exit.cause });
  });

  return {
    /** True while Squirrel is staging a download, which cannot be
        interrupted, so the caller skips the update check. */
    holdsChecks: Effect.fn("desktop.updates.nativeStagingHoldsChecks")(function* (reason: string) {
      const nativeStage = yield* Ref.get(nativeStageRef);
      if (nativeStage?.status !== "staging") return false;
      yield* logInfo("skipping update check while an update is staging", {
        reason,
        version: nativeStage.version,
      });
      return true;
    }),

    /** Whether a download is already staged, which before a handoff means
        it staged in the background rather than at the restart. */
    stagedInBackground: Effect.map(
      Ref.get(nativeStageRef),
      (nativeStage) => nativeStage?.status === "staged",
    ),

    /** MacUpdater re-emits Squirrel.Mac errors. A background staging failure
        only moves staging to quit time, so the caller ignores the error. This
        runs synchronously from the emit, before staging records its outcome. */
    absorbsError: Effect.fn("desktop.updates.nativeStagingAbsorbsError")(function* (error: {
      readonly message: string;
      readonly _tag: string;
    }) {
      if ((yield* Ref.get(nativeStageRef))?.status !== "staging") return false;
      yield* logWarning(error.message, { errorTag: error._tag, operation: "stage" });
      return true;
    }),

    /** Records the download electron-updater just pointed Squirrel's feed at,
        whatever its channel. */
    recordFeed: (version: string) => Ref.set(nativeFeedRef, { version, spent: false }),

    /** Stages each selected-channel download once, right after it downloads.
        Where Squirrel would need administrator rights, staging stays at quit. */
    stageDownloaded: (version: string) =>
      options.enabled
        ? lock.withPermits(1)(
            Effect.gen(function* () {
              if (
                (yield* Ref.get(nativeStageRef)) !== undefined ||
                (yield* options.quitting) ||
                (yield* options.downloadedVersion) !== version ||
                !(yield* nativeUpdater.canStageInBackground)
              ) {
                return;
              }
              yield* stageLocked(version);
              if ((yield* Ref.get(nativeStageRef))?.status === "staged") {
                yield* options.onStaged(version);
              }
            }),
          )
        : Effect.void,

    /** Hands a ready download to the installer. On macOS this waits for
        staging in progress and installs only the staged selected-channel
        download. When background staging failed or was skipped, it stages now
        on the same native updater (quit-time staging), waiting for Squirrel's
        outcome: MacUpdater's own quitAndInstall waits only for success. */
    handOffToInstaller: (flags: InstallFlags) =>
      options.enabled
        ? lock.withPermits(1)(
            Effect.gen(function* () {
              const downloadedVersion = yield* options.downloadedVersion;
              const feed = yield* Ref.get(nativeFeedRef);
              const status = (yield* Ref.get(nativeStageRef))?.status;
              if (
                downloadedVersion !== null &&
                (status === undefined || status === "failed") &&
                feed?.version === downloadedVersion &&
                !feed.spent
              ) {
                yield* stageLocked(downloadedVersion);
              }
              const nativeStage = yield* Ref.get(nativeStageRef);
              if (nativeStage?.status !== "staged" || nativeStage.version !== downloadedVersion) {
                return yield* new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
                  channel: null,
                  ...flags,
                  cause: new Error(`Update ${downloadedVersion} is not staged for installation.`),
                });
              }
              yield* electronUpdater.quitAndInstall(flags);
            }),
          )
        : electronUpdater.quitAndInstall(flags),

    /** Before downloading a newer release: removes the staged update so the
        newer download can stage. False when the ShipIt job cannot be
        removed; the staged update then stays what the next exit installs. */
    releaseSuperseded: (version: string) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const nativeStage = yield* Ref.get(nativeStageRef);
          if (!options.enabled || nativeStage?.status !== "staged") return true;
          if (nativeStage.version === version) return true;
          const discarded = yield* nativeUpdater.discard.pipe(Effect.exit);
          if (Exit.isFailure(discarded)) {
            yield* logWarning("could not discard a superseded staged update", {
              version: nativeStage.version,
              newerVersion: version,
              cause: discarded.cause,
            });
            return false;
          }
          yield* Ref.update(nativeFeedRef, (feed) => feed && { ...feed, spent: true });
          yield* Ref.set(nativeStageRef, undefined);
          yield* options.onDiscarded;
          yield* logInfo("discarded a superseded staged update", {
            version: nativeStage.version,
            newerVersion: version,
          });
          return true;
        }),
      ),

    /** Before a channel change: removes any staged update and clears the
        download, so the old channel's update cannot install on quit. */
    discardForChannelChange: (nextChannel: DesktopUpdateChannel) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          // Always discard: a ShipIt job may also be left from an earlier
          // process, such as one launchd restarted after a failed install.
          if (options.enabled && (yield* options.updaterConfigured)) {
            yield* nativeUpdater.discard.pipe(
              Effect.mapError(
                (cause) =>
                  new DesktopUpdateStagedUpdateDiscardError({
                    requestedChannel: nextChannel,
                    cause,
                  }),
              ),
            );
            // The download can only install again after a new download.
            yield* Ref.update(nativeFeedRef, (feed) => feed && { ...feed, spent: true });
            yield* options.clearDownload;
            yield* logInfo("discarded any staged update before channel change", {
              channel: nextChannel,
            });
          }
          yield* Ref.set(nativeStageRef, undefined);
          yield* options.onDiscarded;
        }),
      ),
  };
});
