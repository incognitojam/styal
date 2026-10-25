// @effect-diagnostics nodeBuiltinImport:off -- Squirrel.Mac staging needs the running bundle path and its launchd job, outside the Effect platform layer this service does not depend on.
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
      : "Could not discard the update staged by Squirrel.Mac.";
  }
}

/** Squirrel.Mac, which electron-updater's MacUpdater drives through Electron's
    native autoUpdater. macOS only. */
export class ElectronNativeUpdater extends Context.Service<
  ElectronNativeUpdater,
  {
    /** Whether Squirrel.Mac can replace the app without asking for
        administrator rights. Its ShipIt job is then a user launchd job. */
    readonly canStageInBackground: Effect.Effect<boolean>;
    /** Has Squirrel.Mac unpack, verify, and stage the download that
        MacUpdater's feed serves, completing on Squirrel's own terminal event.
        Squirrel writes ShipItState.plist and then submits its ShipIt job,
        which installs that request whenever the app exits. */
    readonly stage: Effect.Effect<void, ElectronNativeUpdaterError>;
    /** Removes the user ShipIt job, verifies it is gone, then deletes its
        request on a best-effort basis. */
    readonly discard: Effect.Effect<void, ElectronNativeUpdaterError>;
  }
>()("@t3tools/desktop/electron/ElectronNativeUpdater") {}

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

// <bundle>.app/Contents/MacOS/<executable>, with symlinks resolved like Squirrel.
const runningAppBundlePath = () =>
  NodeFS.realpathSync(NodePath.resolve(app.getPath("exe"), "..", "..", ".."));

const isWritable = (path: string) => {
  try {
    NodeFS.accessSync(path, NodeFS.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

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

// launchctl exit codes when no job has the label: `remove` 3, `print` 113.
const LAUNCHCTL_REMOVE_NO_SUCH_JOB = 3;
const LAUNCHCTL_PRINT_NO_SUCH_JOB = 113;

/** @public */
export const make = ElectronNativeUpdater.of({
  canStageInBackground: Effect.sync(() => {
    const bundlePath = runningAppBundlePath();
    return isWritable(bundlePath) && isWritable(NodePath.dirname(bundlePath));
  }),
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
    // The call MacUpdater makes itself when autoInstallOnAppQuit is true. It
    // set the native feed to the downloaded zip before emitting
    // update-downloaded, creating a fresh native updater.
    try {
      nativeAutoUpdater.checkForUpdates();
    } catch (cause) {
      onError(cause);
    }
    return Effect.sync(cleanup);
  }),
  discard: Effect.tryPromise({
    try: async () => {
      const label = await shipItJobLabel();
      // Squirrel removes this job itself before submitting a replacement.
      // While the app runs, ShipIt is only waiting for it to exit.
      await execFile("launchctl", ["remove", label]).catch((error: { code?: unknown }) => {
        if (error.code !== LAUNCHCTL_REMOVE_NO_SUCH_JOB) throw error;
      });
      const stillLoaded = await execFile("launchctl", [
        "print",
        `gui/${NodeOS.userInfo().uid}/${label}`,
      ]).then(
        () => true,
        (error: { code?: unknown }) => {
          if (error.code === LAUNCHCTL_PRINT_NO_SUCH_JOB) return false;
          throw error;
        },
      );
      if (stillLoaded) throw new Error(`${label} is still loaded after launchctl remove.`);
      // Without the job nothing reads the request; the next staging rewrites it.
      await NodeFS.promises
        .rm(NodePath.join(NodeOS.homedir(), "Library", "Caches", label, "ShipItState.plist"), {
          force: true,
        })
        .catch(() => undefined);
    },
    catch: (cause) => new ElectronNativeUpdaterError({ operation: "discard", cause }),
  }),
});

export const layer = Layer.succeed(ElectronNativeUpdater, make);
