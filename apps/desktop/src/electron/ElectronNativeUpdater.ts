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
      ? "macOS couldn't prepare the downloaded update for installing."
      : this.cause instanceof Error
        ? this.cause.message
        : "If this keeps happening, ask your administrator to check styal's update job in launchd.";
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
  const { stdout } = await execFile(
    "plutil",
    ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlist],
    { timeout: 5_000, encoding: "utf8" },
  );
  const bundleIdentifier = stdout.trim();
  if (bundleIdentifier === "") throw new Error(`No CFBundleIdentifier in ${infoPlist}`);
  return `${bundleIdentifier}.ShipIt`;
};

const inspectJob = async (target: string, label: string) =>
  execFile("launchctl", ["print", target], { timeout: 5_000, encoding: "utf8" }).then(
    ({ stdout }) => {
      const running = isPendingNativeUpdateJob(stdout);
      return { running, finished: !running && /^\s*last exit code = 0\s*$/m.test(stdout) };
    },
    (error: unknown) => {
      if (isNativeUpdateJobMissing(error, label)) return undefined;
      throw new Error(
        `styal couldn't check its update job. For your administrator: launchctl print ${target} failed.`,
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
          if (job?.running && !(options?.ownStaged && index === 0)) {
            throw new Error(
              `An update is running or waiting for styal to quit. For your administrator: launchd job ${targets[index]}.`,
            );
          }
        }
        for (const [index, job] of jobs.entries()) {
          // A successful stopped job will not respawn; Squirrel replaces it before its next submit.
          if (job === undefined || job.finished) continue;
          const target = targets[index]!;
          // A job staged by this process cannot have passed its app-termination wait.
          await execFile("launchctl", ["bootout", target], {
            timeout: 5_000,
            encoding: "utf8",
          }).catch(async (error: unknown) => {
            if ((await inspectJob(target, label)) !== undefined) {
              throw new Error(
                `styal couldn't remove its update job. For your administrator: unload ${target} after confirming no installation is running.`,
                { cause: error },
              );
            }
          });
          if ((await inspectJob(target, label)) !== undefined) {
            throw new Error(
              `styal's update job is still loaded. For your administrator: ${target}.`,
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
