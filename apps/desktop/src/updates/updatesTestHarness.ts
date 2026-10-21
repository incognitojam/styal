import * as DesktopShutdownGuard from "../app/DesktopShutdownGuard.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { DesktopFeatureUsageReport, DesktopUpdateState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

/** Shared DesktopUpdates test harness: a fully stubbed updater layer whose
    electron-updater events are driven by hand via `emit`. Used by
    DesktopUpdates.test.ts and DesktopRemoteUpdates.test.ts. */

export const flushCallbacks = Effect.yieldNow;

export interface UpdatesHarnessOptions {
  readonly confirmShutdown?: Effect.Effect<boolean>;
  readonly installWait?: Effect.Effect<void>;
  readonly installError?: ElectronUpdater.ElectronUpdaterQuitAndInstallError;
  readonly checkForUpdates?: Effect.Effect<
    void,
    ElectronUpdater.ElectronUpdaterCheckForUpdatesError
  >;
  readonly beforeSetUpdateChannel?: Effect.Effect<void>;
  readonly setUpdateChannelError?: DesktopAppSettings.DesktopSettingsWriteError;
  readonly setDisableDifferentialDownload?: Effect.Effect<void>;
  readonly downloadUpdate?: Effect.Effect<void, ElectronUpdater.ElectronUpdaterDownloadUpdateError>;
  readonly quitAndInstall?: Effect.Effect<void, ElectronUpdater.ElectronUpdaterQuitAndInstallError>;
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
  readonly stopBackend?: Effect.Effect<void>;
  readonly startBackend?: Effect.Effect<void>;
  readonly env?: Record<string, string | undefined>;
  readonly platform?: NodeJS.Platform;
  /** Contents of the resources/package-type marker a Linux package ships. */
  readonly packageType?: string | undefined;
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

export function makeHarness(options: UpdatesHarnessOptions = {}) {
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
  let autoInstallOnAppQuit = false;
  const installs: Array<{ isSilent: boolean; isForceRunAfter: boolean }> = [];
  let checkCount = 0;
  let quitAndInstallCount = 0;
  let downloadCount = 0;
  // Squirrel.Mac (8d80880) as electron-updater 6.8.9's MacUpdater drives it.
  // Every update-downloaded follows a setFeedURL, which creates a fresh native
  // updater. Staging writes ShipItState.plist (`request`) and then submits the
  // ShipIt job, once per native updater. On exit, ShipIt installs `request`.
  // MacUpdater's `staged` flag is set by any successful staging and never
  // reset; quitAndInstall stages first only while it is unset.
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
  let allowDowngrade = false;
  let fullChangelog = false;
  const feedUrls: ElectronUpdater.ElectronUpdaterFeedUrl[] = [];
  const listeners = new Map<string, Set<(...args: readonly unknown[]) => void>>();
  const sentStates: DesktopUpdateState[] = [];
  const installSteps: string[] = [];

  const addListener = (eventName: string, listener: (...args: readonly unknown[]) => void) => {
    const eventListeners = listeners.get(eventName) ?? new Set();
    eventListeners.add(listener);
    listeners.set(eventName, eventListeners);
  };

  const removeListener = (eventName: string, listener: (...args: readonly unknown[]) => void) => {
    const eventListeners = listeners.get(eventName);
    if (!eventListeners) {
      return;
    }
    eventListeners.delete(listener);
    if (eventListeners.size === 0) {
      listeners.delete(eventName);
    }
  };

  const harnessEmit = (eventName: string, payload?: unknown) => {
    if (eventName === "update-downloaded") {
      squirrel.feedVersion = (payload as { version: string }).version;
      squirrel.feedSubmitted = false;
    }
    for (const listener of listeners.get(eventName) ?? []) {
      listener(payload);
    }
  };

  const layerUpdater = Layer.succeed(ElectronUpdater.ElectronUpdater, {
    setFeedURL: (options) =>
      Effect.sync(() => {
        feedUrls.push(options);
      }),
    setAutoDownload: () => Effect.void,
    setAutoInstallOnAppQuit: (value) =>
      Effect.sync(() => {
        autoInstallOnAppQuit = value;
      }),
    setChannel: () => Effect.void,
    setAllowPrerelease: () => Effect.void,
    allowDowngrade: Effect.sync(() => allowDowngrade),
    setAllowDowngrade: (value) =>
      Effect.sync(() => {
        allowDowngrade = value;
      }),
    setFullChangelog: (value) =>
      Effect.sync(() => {
        fullChangelog = value;
      }),
    setDisableDifferentialDownload: () => options.setDisableDifferentialDownload ?? Effect.void,
    checkForUpdates: Effect.sync(() => {
      checkCount += 1;
    }).pipe(Effect.andThen(options.checkForUpdates ?? Effect.void)),
    downloadUpdate: Effect.sync(() => {
      downloadCount += 1;
    }).pipe(Effect.andThen(options.downloadUpdate ?? Effect.void)),
    quitAndInstall: (flags) =>
      Effect.sync(() => {
        installs.push(flags);
        quitAndInstallCount += 1;
        installSteps.push("quitAndInstall");
        if (!squirrel.staged) stageFromFeed();
        squirrel.installedOnExit.push(squirrel.job ? squirrel.request : undefined);
      }).pipe(
        Effect.andThen(
          options.quitAndInstall ??
            (options.installError
              ? Effect.fail(options.installError)
              : (options.installWait ?? Effect.void)),
        ),
      ),
    canStageNativeUpdateInBackground: Effect.succeed(options.stagesInBackground ?? false),
    stageNativeUpdate: Effect.sync(() => {
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
            harnessEmit("error", new Error("Squirrel.Mac staging failed"));
          }
          return Effect.fail(
            new ElectronUpdater.ElectronUpdaterNativeUpdateError({
              operation: "stage",
              cause: new Error(`staging failed ${failure}`),
            }),
          );
        }),
      ),
    ),
    discardNativeUpdate: Effect.suspend(() => {
      squirrel.discardCount += 1;
      if (options.discardNativeUpdateFailure === "job-removal") {
        return Effect.fail(
          new ElectronUpdater.ElectronUpdaterNativeUpdateError({
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
    on: (eventName, listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          addListener(eventName, listener as unknown as (...args: readonly unknown[]) => void);
        }),
        () =>
          Effect.sync(() => {
            removeListener(eventName, listener as unknown as (...args: readonly unknown[]) => void);
          }),
      ).pipe(Effect.asVoid),
  } satisfies ElectronUpdater.ElectronUpdater["Service"]);

  const layerWindow = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected BrowserWindow creation"),
    main: Effect.succeedNone,
    currentMainOrFirst: Effect.succeedNone,
    focusedMainOrFirst: Effect.succeedNone,
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    prepareReveal: () => Effect.succeed(false),
    reveal: () => Effect.void,
    sendAll: (_channel, state) =>
      Effect.sync(() => {
        sentStates.push(state as DesktopUpdateState);
      }),
    destroyAll: Effect.sync(() => {
      installSteps.push("destroyAll");
    }),
    syncAllAppearance: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  const stubBackendInstance: DesktopBackendPool.DesktopBackendInstance = {
    id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Windows"),
    start: Effect.sync(() => {
      installSteps.push("startBackend");
    }).pipe(Effect.andThen(options.startBackend ?? Effect.void)),
    stop: () => options.stopBackend ?? Effect.void,
    currentConfig: Effect.succeedNone,
    snapshot: Effect.succeed({
      desiredRunning: false,
      ready: false,
      activePid: Option.none(),
      restartAttempt: 0,
      restartScheduled: false,
    }),
    waitForReady: () => Effect.succeed(true),
  };
  const layerBackend = DesktopBackendPool.layerTest([stubBackendInstance]);

  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: `/tmp/t3-desktop-updates-home-${process.pid}`,
    platform: options.platform ?? "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          STYAL_HOME: `/tmp/t3-desktop-updates-test-${process.pid}`,
          T3CODE_DESKTOP_MOCK_UPDATES: "true",
          T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: "4141",
          ...options.env,
        }),
      ),
    ),
  );

  let testSettings: DesktopAppSettings.DesktopSettings = {
    ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
  };
  const setUpdateChannelError = options.setUpdateChannelError;
  const layerSettings =
    setUpdateChannelError || options.beforeSetUpdateChannel
      ? Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
          get: Effect.sync(() => testSettings),
          load: Effect.sync(() => testSettings),
          setMainWindowBounds: () => Effect.die("unexpected main window bounds update"),
          setServerExposureMode: () => Effect.die("unexpected server exposure update"),
          setTailscaleServe: () => Effect.die("unexpected Tailscale Serve update"),
          setUpdateChannel: (channel) =>
            setUpdateChannelError
              ? Effect.fail(setUpdateChannelError)
              : (options.beforeSetUpdateChannel ?? Effect.void).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      const changed = testSettings.updateChannel !== channel;
                      testSettings = {
                        ...testSettings,
                        updateChannel: channel,
                        updateChannelConfiguredByUser: true,
                      };
                      return { settings: testSettings, changed };
                    }),
                  ),
                ),
          setWslBackendEnabled: () => Effect.die("unexpected WSL backend toggle"),
          setWslDistro: () => Effect.die("unexpected WSL distro change"),
          setLocalEnvironmentEnabled: () => Effect.die("unexpected local environment toggle"),
          setWslOnly: () => Effect.die("unexpected WSL-only toggle"),
          applyWslWindowsFallback: Effect.die("unexpected WSL Windows fallback"),
          applyWslWindowsFallbackInMemory: Effect.die("unexpected WSL Windows fallback"),
        } satisfies DesktopAppSettings.DesktopAppSettings["Service"])
      : DesktopAppSettings.layer;

  // Tracks the restart markers installs leave, so installs stay free of real
  // disk I/O that would outrun the tests' settle loops.
  const updateRestartMarkers = new Set<string>();
  // The idle restart pending file is kept apart from the restart markers.
  const isIdleRestartFile = (path: string) => path.endsWith("update-idle-restart-pending");
  const layerFileSystem = FileSystem.layerNoop({
    readFileString: (path) =>
      path === "/missing/resources/package-type" && options.packageType !== undefined
        ? Effect.succeed(options.packageType)
        : isIdleRestartFile(path) && idleRestart.pendingFile !== undefined
          ? Effect.succeed(idleRestart.pendingFile)
          : Effect.fail(
              PlatformError.systemError({
                module: "FileSystem",
                method: "readFileString",
                _tag: "NotFound",
                pathOrDescriptor: path,
              }),
            ),
    makeDirectory: () => Effect.void,
    writeFileString: (path, contents) =>
      Effect.sync(() => {
        if (isIdleRestartFile(path)) idleRestart.pendingFile = contents;
        else updateRestartMarkers.add(path);
      }),
    remove: (path) =>
      Effect.sync(() => {
        if (isIdleRestartFile(path)) idleRestart.pendingFile = undefined;
        updateRestartMarkers.delete(path);
      }),
  });

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
    publishFeatureUsage: (report) =>
      Effect.sync(() => {
        idleRestart.reports.push(report);
      }),
    updateRequests: Stream.empty,
    updateCommits: Stream.empty,
    updateCancellations: Stream.empty,
  } satisfies DesktopTelemetryPublisher.DesktopTelemetryPublisher["Service"]);

  const layer = DesktopUpdates.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(DesktopShutdownGuard.DesktopShutdownGuard, {
        confirm: () => options.confirmShutdown ?? Effect.succeed(true),
        inspect: Effect.sync(() => {
          idleRestart.inspections += 1;
          idleRestart.onInspect?.();
          return idleRestart.hosts;
        }),
      }),
    ),
    Layer.provide(layerPowerMonitor),
    Layer.provideMerge(layerTelemetry),
    Layer.provide(layerFileSystem),
    Layer.provideMerge(layerUpdater),
    Layer.provideMerge(layerWindow),
    Layer.provideMerge(layerBackend),
    Layer.provideMerge(DesktopState.layer),
    Layer.provideMerge(layerSettings),
    Layer.provideMerge(
      DesktopConfig.layerTest({
        STYAL_HOME: `/tmp/t3-desktop-updates-test-${process.pid}`,
        T3CODE_DESKTOP_MOCK_UPDATES: "true",
        T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: "4141",
        ...options.env,
      }),
    ),
    Layer.provideMerge(layerEnvironment),
    Layer.provideMerge(NodeServices.layer),
  );

  return {
    installs,
    autoInstallOnAppQuit: () => autoInstallOnAppQuit,
    layer,
    checkCount: () => checkCount,
    quitAndInstalls: () => quitAndInstallCount,
    installSteps,
    updateRestartMarkers,
    downloadCount: () => downloadCount,
    feedUrls: (): ElectronUpdater.ElectronUpdaterFeedUrl[] => feedUrls,
    fullChangelog: () => fullChangelog,
    listenerCount: () =>
      Array.from(listeners.values()).reduce(
        (total, eventListeners) => total + eventListeners.size,
        0,
      ),
    sentStates,
    squirrel,
    idleRestart,
    emit: harnessEmit,
  };
}
