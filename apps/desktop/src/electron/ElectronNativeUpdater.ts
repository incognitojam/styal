// @effect-diagnostics nodeBuiltinImport:off -- Legacy Squirrel.Mac cleanup needs the running bundle path and its launchd job, outside the Effect platform layer this service does not depend on.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { app, autoUpdater as nativeAutoUpdater } from "electron";
import { isNativeUpdateJobMissing, isPendingNativeUpdateJob } from "../updates/nativeUpdateJob.ts";

export class ElectronNativeUpdaterError extends Schema.TaggedError<ElectronNativeUpdaterError>()(
  "ElectronNativeUpdaterError",
  {
    operation: Schema.Literals(["stage", "discard"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.operation === "stage"
      ? "Squirrel.Mac could not stage the downloaded update."
      : `Cannot safely clear a previous native update. ${this.cause instanceof Error ? this.cause.message : "Have your administrator inspect the ShipIt launchd job."} Keep styal open until it is resolved; quitting could install the previous update. This does not disable update checks or downloads.`;
  }
}

/** Squirrel.Mac, which electron-updater's MacUpdater drives through Electron's
    native autoUpdater. macOS only. */
export class ElectronNativeUpdater extends Context.Service<
  ElectronNativeUpdater,
  {
    readonly stage: Effect.Effect<void, ElectronNativeUpdaterError>;
    /** Refuses to terminate a running inherited installer or touch its recovery state. */
    readonly discard: (options?: {
      readonly ownStaged?: boolean;
    }) => Effect.Effect<void, ElectronNativeUpdaterError>;
  }
>()("@t3tools/desktop/electron/ElectronNativeUpdater") {}

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

// <bundle>.app/Contents/MacOS/<executable>, with symlinks resolved like Squirrel.
const runningAppBundlePath = () =>
  NodeFS.realpathSync(NodePath.resolve(app.getPath("exe"), "..", "..", ".."));

// Squirrel names its job and cache directory `<bundle id>.ShipIt`.
const shipItJobLabel = async () => {
  const infoPlist = NodePath.join(runningAppBundlePath(), "Contents", "Info.plist");
  const { stdout } = await execFile("plutil", [
    "-extract",
    "CFBundleIdentifier",
    "raw",
    "-o",
    "-",
    infoPlist,
  ]);
  const bundleIdentifier = stdout.trim();
  if (bundleIdentifier === "") throw new Error(`No CFBundleIdentifier in ${infoPlist}`);
  return `${bundleIdentifier}.ShipIt`;
};

const inspectJob = async (target: string, label: string) =>
  execFile("launchctl", ["print", target]).then(
    ({ stdout }) => ({ running: isPendingNativeUpdateJob(stdout) }),
    (error: unknown) => {
      if (isNativeUpdateJobMissing(error, label)) return undefined;
      throw new Error(
        `Could not inspect ${target}. Have your administrator check launchctl permissions.`,
        { cause: error },
      );
    },
  );

/** @public */
export const make = ElectronNativeUpdater.of({
  stage: Effect.callback<void, ElectronNativeUpdaterError>((resume) => {
    const onDownloaded = () => {
      cleanup();
      resume(Effect.void);
    };
    const onError = (cause: unknown) => {
      cleanup();
      resume(Effect.fail(new ElectronNativeUpdaterError({ operation: "stage", cause })));
    };
    const onNotAvailable = () => onError(new Error("Squirrel.Mac found no update to stage."));
    const cleanup = () => {
      nativeAutoUpdater.removeListener("update-downloaded", onDownloaded);
      nativeAutoUpdater.removeListener("update-not-available", onNotAvailable);
      nativeAutoUpdater.removeListener("error", onError);
    };
    nativeAutoUpdater.once("update-downloaded", onDownloaded);
    nativeAutoUpdater.once("update-not-available", onNotAvailable);
    nativeAutoUpdater.once("error", onError);
    try {
      nativeAutoUpdater.checkForUpdates();
    } catch (cause) {
      onError(cause);
    }
    return Effect.sync(cleanup);
  }),
  discard: Effect.fn("ElectronNativeUpdater.discard")((options) =>
    Effect.tryPromise({
      try: async () => {
        const label = await shipItJobLabel();
        const targets = [`gui/${NodeOS.userInfo().uid}/${label}`, `system/${label}`];
        // Inspect both before removing either: a privileged installer may share the user's request.
        const jobs = await Promise.all(targets.map((target) => inspectJob(target, label)));
        for (const [index, job] of jobs.entries()) {
          if (job?.running && !options?.ownStaged) {
            throw new Error(
              `${targets[index]} is running or waiting for app exit. Have your administrator inspect it; an active installation must finish before this action can proceed.`,
            );
          }
        }
        for (const [index, job] of jobs.entries()) {
          if (job === undefined) continue;
          const target = targets[index]!;
          // A job staged by this process cannot have passed its app-termination wait.
          await execFile("launchctl", ["bootout", target]).catch(async (error: unknown) => {
            if ((await inspectJob(target, label)) !== undefined) {
              throw new Error(
                `Could not remove ${target}. Ask your administrator to unload this job after checking that no installation is active.`,
                { cause: error },
              );
            }
          });
          if ((await inspectJob(target, label)) !== undefined) {
            throw new Error(
              `${target} is still loaded. Ask your administrator to inspect it before quitting.`,
            );
          }
        }
        // Keep ShipItState and installer preferences: an interrupted install may need them to recover.
      },
      catch: (cause) => new ElectronNativeUpdaterError({ operation: "discard", cause }),
    }),
  ),
});

export const layer = Layer.succeed(ElectronNativeUpdater, make);
