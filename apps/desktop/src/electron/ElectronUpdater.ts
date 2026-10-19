// @effect-diagnostics nodeBuiltinImport:off -- Squirrel.Mac staging needs the running bundle path and its launchd job, outside the Effect platform layer this service does not depend on.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { autoUpdater } from "electron-updater";
import { app, autoUpdater as nativeAutoUpdater } from "electron";

type AutoUpdater = typeof autoUpdater;

export type ElectronUpdaterFeedUrl = Parameters<AutoUpdater["setFeedURL"]>[0];

export class ElectronUpdaterCheckForUpdatesError extends Schema.TaggedError<ElectronUpdaterCheckForUpdatesError>()(
  "ElectronUpdaterCheckForUpdatesError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to check for updates on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterDownloadUpdateError extends Schema.TaggedError<ElectronUpdaterDownloadUpdateError>()(
  "ElectronUpdaterDownloadUpdateError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to download the update on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterQuitAndInstallError extends Schema.TaggedError<ElectronUpdaterQuitAndInstallError>()(
  "ElectronUpdaterQuitAndInstallError",
  {
    channel: Schema.NullOr(Schema.String),
    isSilent: Schema.Boolean,
    isForceRunAfter: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to quit and install the update on channel ${this.channel ?? "default"} (silent: ${this.isSilent}, force run after: ${this.isForceRunAfter}).`;
  }
}

export class ElectronUpdaterNativeUpdateError extends Schema.TaggedError<ElectronUpdaterNativeUpdateError>()(
  "ElectronUpdaterNativeUpdateError",
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

export const ElectronUpdaterError = Schema.Union([
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
  ElectronUpdaterNativeUpdateError,
]);
export type ElectronUpdaterError = typeof ElectronUpdaterError.Type;

export class ElectronUpdater extends Context.Service<
  ElectronUpdater,
  {
    readonly setFeedURL: (options: ElectronUpdaterFeedUrl) => Effect.Effect<void>;
    readonly setAutoDownload: (value: boolean) => Effect.Effect<void>;
    readonly setAutoInstallOnAppQuit: (value: boolean) => Effect.Effect<void>;
    readonly setChannel: (channel: string) => Effect.Effect<void>;
    readonly setAllowPrerelease: (value: boolean) => Effect.Effect<void>;
    readonly allowDowngrade: Effect.Effect<boolean>;
    readonly setAllowDowngrade: (value: boolean) => Effect.Effect<void>;
    readonly setFullChangelog: (value: boolean) => Effect.Effect<void>;
    readonly setDisableDifferentialDownload: (value: boolean) => Effect.Effect<void>;
    readonly checkForUpdates: Effect.Effect<void, ElectronUpdaterCheckForUpdatesError>;
    readonly downloadUpdate: Effect.Effect<void, ElectronUpdaterDownloadUpdateError>;
    readonly quitAndInstall: (options: {
      readonly isSilent: boolean;
      readonly isForceRunAfter: boolean;
    }) => Effect.Effect<void, ElectronUpdaterQuitAndInstallError>;
    /** macOS: whether Squirrel.Mac can replace the app without asking for
        administrator rights. Its ShipIt job is then a user launchd job. */
    readonly canStageNativeUpdateInBackground: Effect.Effect<boolean>;
    /** macOS: has Squirrel.Mac unpack, verify, and stage the download that
        MacUpdater's feed serves, completing on Squirrel's own terminal event.
        Squirrel writes ShipItState.plist and then submits its ShipIt job,
        which installs that request whenever the app exits. */
    readonly stageNativeUpdate: Effect.Effect<void, ElectronUpdaterNativeUpdateError>;
    /** macOS: removes the user ShipIt job, verifies it is gone, then deletes
        its request on a best-effort basis. */
    readonly discardNativeUpdate: Effect.Effect<void, ElectronUpdaterNativeUpdateError>;
    readonly on: <Args extends ReadonlyArray<unknown>>(
      eventName: string,
      listener: (...args: Args) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronUpdater") {}

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

/** @public Service construction is part of the canonical Effect module API. */
export const make = ElectronUpdater.of({
  setFeedURL: (options) =>
    Effect.suspend(() => {
      autoUpdater.setFeedURL(options);
      return Effect.void;
    }),
  setAutoDownload: (value) =>
    Effect.suspend(() => {
      autoUpdater.autoDownload = value;
      return Effect.void;
    }),
  setAutoInstallOnAppQuit: (value) =>
    Effect.suspend(() => {
      autoUpdater.autoInstallOnAppQuit = value;
      return Effect.void;
    }),
  setChannel: (channel) =>
    Effect.suspend(() => {
      autoUpdater.channel = channel;
      return Effect.void;
    }),
  setAllowPrerelease: (value) =>
    Effect.suspend(() => {
      autoUpdater.allowPrerelease = value;
      return Effect.void;
    }),
  allowDowngrade: Effect.sync(() => autoUpdater.allowDowngrade),
  setAllowDowngrade: (value) =>
    Effect.suspend(() => {
      autoUpdater.allowDowngrade = value;
      return Effect.void;
    }),
  setFullChangelog: (value) =>
    Effect.suspend(() => {
      autoUpdater.fullChangelog = value;
      return Effect.void;
    }),
  setDisableDifferentialDownload: (value) =>
    Effect.suspend(() => {
      autoUpdater.disableDifferentialDownload = value;
      return Effect.void;
    }),
  checkForUpdates: Effect.suspend(() => {
    const channel = autoUpdater.channel;
    return Effect.tryPromise({
      try: () => autoUpdater.checkForUpdates(),
      catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel, cause }),
    }).pipe(Effect.asVoid);
  }),
  downloadUpdate: Effect.suspend(() => {
    const channel = autoUpdater.channel;
    return Effect.tryPromise({
      try: () => autoUpdater.downloadUpdate(),
      catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel, cause }),
    }).pipe(Effect.asVoid);
  }),
  quitAndInstall: ({ isSilent, isForceRunAfter }) =>
    Effect.suspend(() => {
      const channel = autoUpdater.channel;
      const fail = (cause: unknown) =>
        new ElectronUpdaterQuitAndInstallError({
          channel,
          isSilent,
          isForceRunAfter,
          cause,
        });
      // MacUpdater ignores quitAndInstall's arguments and reads this property.
      autoUpdater.autoRunAppAfterInstall = isForceRunAfter;
      if (isForceRunAfter) {
        return Effect.try({
          try: () => autoUpdater.quitAndInstall(isSilent, isForceRunAfter),
          catch: fail,
        });
      }
      // Native macOS staging finishes asynchronously. If it fails, let the
      // lifecycle finish quitting instead of leaving an invisible app running.
      return Effect.callback<void, ElectronUpdaterQuitAndInstallError>((resume) => {
        const onError = (cause: unknown) => {
          cleanup();
          resume(Effect.fail(fail(cause)));
        };
        const onQuit = () => {
          cleanup();
          resume(Effect.void);
        };
        const cleanup = () => {
          autoUpdater.removeListener("error", onError);
          app.removeListener("quit", onQuit);
        };
        autoUpdater.once("error", onError);
        app.once("quit", onQuit);
        try {
          autoUpdater.quitAndInstall(isSilent, isForceRunAfter);
        } catch (cause) {
          onError(cause);
        }
        return Effect.sync(cleanup);
      });
    }),
  canStageNativeUpdateInBackground: Effect.sync(() => {
    const bundlePath = runningAppBundlePath();
    return isWritable(bundlePath) && isWritable(NodePath.dirname(bundlePath));
  }),
  stageNativeUpdate: Effect.callback<void, ElectronUpdaterNativeUpdateError>((resume) => {
    const onDownloaded = () => {
      cleanup();
      resume(Effect.void);
    };
    const onError = (cause: unknown) => {
      cleanup();
      resume(Effect.fail(new ElectronUpdaterNativeUpdateError({ operation: "stage", cause })));
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
  discardNativeUpdate: Effect.tryPromise({
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
    catch: (cause) => new ElectronUpdaterNativeUpdateError({ operation: "discard", cause }),
  }),
  on: (eventName, listener) => {
    const eventTarget = autoUpdater as unknown as {
      on: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
      removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
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
  },
});

export const layer = Layer.succeed(ElectronUpdater, make);
