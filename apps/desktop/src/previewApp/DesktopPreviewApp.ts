// @effect-diagnostics nodeBuiltinImport:off -- The download is hashed as it streams, and Effect's Crypto only digests a whole buffer.
import {
  DESKTOP_PREVIEW_APP_REPOSITORY,
  DesktopPreviewAppFailureReason,
  type DesktopPreviewAppActionResult,
  type DesktopPreviewAppActivity,
  type DesktopPreviewAppBuild,
  type DesktopPreviewAppBuildLookup,
  type DesktopPreviewAppState,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { DESKTOP_INSTALL_IDENTITIES } from "../app/DesktopInstallVariant.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";

// Installs a pull request's unsigned macOS build as `styal (Preview)`. The main process asks the
// person, so renderer code alone can never start it. The app in ~/Applications is the only record
// of what is installed. Files this process writes should not be quarantined; a build that is
// fails with `quarantined` and is never stripped.

const RELEASE_TAG = "desktop-preview";
const API_ROOT = `https://api.github.com/repos/${DESKTOP_PREVIEW_APP_REPOSITORY}`;
const DOWNLOAD_ROOT = `https://github.com/${DESKTOP_PREVIEW_APP_REPOSITORY}/releases/download/${RELEASE_TAG}`;
const APP_BUNDLE_NAME = "styal (Preview).app";
const PREVIEW_IDENTITY = DESKTOP_INSTALL_IDENTITIES.preview;
const STAGING_DIRECTORY_PREFIX = ".styal-preview-install";
// Anonymous GitHub requests share 60 an hour per address, and a 304 still counts.
const RELEASE_LOOKUP_REUSE_MS = 60_000;
// The HTTP client has no body timeout, and an install holds the action while it looks up its build.
const GITHUB_LOOKUP_TIMEOUT = Duration.seconds(30);
const QUARANTINE_ATTRIBUTE = "com.apple.quarantine";
const CLOSED_PULL_REQUEST_CHECK_INTERVAL = Duration.minutes(15);
// Longer than DesktopLifecycle's own shutdown budget, so a clean quit always finishes.
const QUIT_POLL_INTERVAL = Duration.millis(500);
const DEFAULT_QUIT_POLLS = 40;

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-preview-app");

export class DesktopPreviewAppError extends Schema.TaggedError<DesktopPreviewAppError>()(
  "DesktopPreviewAppError",
  { reason: DesktopPreviewAppFailureReason, message: Schema.String },
) {}

class DesktopPreviewAppLookupError extends Schema.TaggedError<DesktopPreviewAppLookupError>()(
  "DesktopPreviewAppLookupError",
  { status: Schema.Number, url: Schema.String },
) {
  override get message(): string {
    return `GitHub answered ${this.status} for ${this.url}`;
  }
}

const fail = (reason: DesktopPreviewAppFailureReason, message: string) =>
  new DesktopPreviewAppError({ reason, message });

const ReleaseResponse = Schema.Struct({
  assets: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      size: Schema.Number,
      state: Schema.String,
      digest: Schema.optional(Schema.NullOr(Schema.String)),
      updated_at: Schema.String,
    }),
  ),
});
type ReleaseAsset = (typeof ReleaseResponse.Type)["assets"][number];

const PullRequestResponse = Schema.Struct({ state: Schema.String });
const ServerRuntimeRecord = Schema.Struct({ pid: Schema.Number });

const decodeRelease = Schema.decodeUnknownEffect(ReleaseResponse);
const decodePullRequest = Schema.decodeUnknownEffect(PullRequestResponse);

export interface PreviewAppAsset extends DesktopPreviewAppBuild {
  readonly assetName: string;
  readonly sha256: string;
}

function parsePreviewVersion(version: string) {
  const match = /-pr\.(\d+)\.(\d+)$/.exec(version);
  return match === null
    ? null
    : { pullRequestNumber: Number(match[1]), runNumber: Number(match[2]) };
}

/**
 * The newest finished DMG published for this pull request. The name must carry the
 * pull request's own marker in full: `-pr.12.` never matches a `-pr.123.` build.
 */
export function selectPreviewAsset(
  assets: ReadonlyArray<ReleaseAsset>,
  pullRequestNumber: number,
): PreviewAppAsset | null {
  const pattern = new RegExp(`^styal-(.+-pr\\.${pullRequestNumber}\\.(\\d+))-arm64\\.dmg$`);
  let selected: PreviewAppAsset | null = null;
  for (const asset of assets) {
    const name = pattern.exec(asset.name);
    const digest = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? "");
    if (asset.state !== "uploaded" || name === null || digest === null) continue;
    const runNumber = Number(name[2]);
    if (selected !== null && selected.runNumber >= runNumber) continue;
    selected = {
      pullRequestNumber,
      runNumber,
      version: name[1]!,
      sizeBytes: asset.size,
      publishedAt: asset.updated_at,
      assetName: asset.name,
      sha256: digest[1]!,
    };
  }
  return selected;
}

/** Preview apps wherever they run from, without their backend children, which exit with them. */
export function parseRunningPreviewApps(psOutput: string) {
  const processes = psOutput.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match !== null && match[3]!.includes(`/${APP_BUNDLE_NAME}/Contents/MacOS/`)
      ? [{ pid: Number(match[1]), parentPid: Number(match[2]) }]
      : [];
  });
  const pids = new Set(processes.map((entry) => entry.pid));
  return {
    all: [...pids],
    roots: processes.filter((entry) => !pids.has(entry.parentPid)).map((entry) => entry.pid),
  };
}

export class DesktopPreviewApp extends Context.Service<
  DesktopPreviewApp,
  {
    readonly state: Effect.Effect<DesktopPreviewAppState>;
    readonly findBuild: (pullRequestNumber: number) => Effect.Effect<DesktopPreviewAppBuildLookup>;
    readonly install: (pullRequestNumber: number) => Effect.Effect<DesktopPreviewAppActionResult>;
    readonly cancelInstall: Effect.Effect<void>;
    readonly open: Effect.Effect<DesktopPreviewAppActionResult>;
    readonly remove: Effect.Effect<DesktopPreviewAppActionResult>;
    readonly resetData: Effect.Effect<DesktopPreviewAppActionResult>;
    /** Removes the installed preview if its pull request has closed and the app is not running. */
    readonly removeIfPullRequestClosed: Effect.Effect<void>;
    /** Whatever a crash left in this variant's staging directory, including an attached DMG. */
    readonly cleanLeftovers: Effect.Effect<void>;
    /** Only the main styal app removes previews on its own, so two variants never race to do it. */
    readonly managesInstalledApp: boolean;
  }
>()("@t3tools/desktop/previewApp/DesktopPreviewApp") {}

const IDLE: DesktopPreviewAppActivity = { status: "idle" };

export const make = Effect.fn("DesktopPreviewApp.make")(function* (options?: {
  readonly quitPolls?: number;
}) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.followRedirects(5));
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const telemetry = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
  const scope = yield* Scope.Scope;
  const { path } = environment;

  const supported = environment.platform === "darwin" && environment.processArch === "arm64";
  const runningAsPreview = environment.installVariant === "preview";
  const quitPolls = options?.quitPolls ?? DEFAULT_QUIT_POLLS;

  const applicationsDirectory = path.join(environment.homeDirectory, "Applications");
  const installedAppPath = path.join(applicationsDirectory, APP_BUNDLE_NAME);
  // Beside the install location, so the final rename stays on one volume. One per variant, because
  // each variant is single-instance but they can run side by side and must not clean up each other.
  const stagingDirectory = path.join(
    applicationsDirectory,
    `${STAGING_DIRECTORY_PREFIX}-${environment.installVariant}`,
  );
  const mountPoint = path.join(stagingDirectory, "mount");
  const previousAppPath = path.join(stagingDirectory, "previous.app");
  const runningFromInstalledApp = environment.appPath.startsWith(`${installedAppPath}/`);
  const previewDataDirectories = [
    path.join(environment.baseDir, PREVIEW_IDENTITY.homeDirName ?? "preview"),
    path.join(environment.appDataDirectory, PREVIEW_IDENTITY.slug),
  ];

  const activityRef = yield* Ref.make<DesktopPreviewAppActivity>(IDLE);
  const lastStateRef = yield* Ref.make<DesktopPreviewAppState | null>(null);
  const installFiberRef = yield* Ref.make<Fiber.Fiber<unknown, DesktopPreviewAppError> | null>(
    null,
  );
  const keepBackupRef = yield* Ref.make(false);
  const lastReleaseRef = yield* Ref.make<{
    readonly assets: ReadonlyArray<ReleaseAsset>;
    readonly fetchedAt: number;
  } | null>(null);

  const run = (command: string, args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(command, [...args], { stdin: "ignore" }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return { stdout, stderr, exitCode: Number(exitCode) };
      }),
    );

  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));

  const readBundle = Effect.fn("DesktopPreviewApp.readBundle")(function* (appPath: string) {
    const plist = path.join(appPath, "Contents", "Info.plist");
    const read = (key: string) =>
      run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist]).pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
        Effect.orElseSucceed(() => null),
      );
    const [identifier, version] = yield* Effect.all([
      read("CFBundleIdentifier"),
      read("CFBundleShortVersionString"),
    ]);
    return { identifier, version };
  });

  const readInstalled = Effect.gen(function* () {
    if (!supported || !(yield* exists(installedAppPath))) return null;
    const { identifier, version } = yield* readBundle(installedAppPath);
    const parsed = version === null ? null : parsePreviewVersion(version);
    return identifier !== PREVIEW_IDENTITY.appUserModelId || version === null || parsed === null
      ? null
      : { version, ...parsed };
  });

  const state: DesktopPreviewApp["Service"]["state"] = Effect.gen(function* () {
    const activity = yield* Ref.get(activityRef);
    const installed = yield* readInstalled;
    const hasData =
      supported &&
      !runningAsPreview &&
      (yield* Effect.forEach(previewDataDirectories, exists)).some(Boolean);
    const next: DesktopPreviewAppState = {
      supported,
      installed,
      opensAfterInstall: !runningAsPreview,
      canInstall: supported && !runningFromInstalledApp,
      canOpen: installed !== null && !runningAsPreview,
      canRemove: installed !== null && !runningFromInstalledApp,
      canReset: hasData,
      activity,
    };
    yield* Ref.set(lastStateRef, next);
    return next;
  });

  const publishState = state.pipe(
    Effect.flatMap((next) => electronWindow.sendAll(IpcChannels.PREVIEW_APP_STATE_CHANNEL, next)),
  );

  // Runs for every percent of a download, so it reuses the last read of the disk.
  const setActivity = Effect.fnUntraced(function* (activity: DesktopPreviewAppActivity) {
    yield* Ref.set(activityRef, activity);
    const last = yield* Ref.get(lastStateRef);
    if (last === null) return yield* publishState;
    yield* electronWindow.sendAll(IpcChannels.PREVIEW_APP_STATE_CHANNEL, { ...last, activity });
  });

  const getGitHubJson = Effect.fn("DesktopPreviewApp.getGitHubJson")(function* (url: string) {
    const response = yield* http.execute(
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeaders({
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": `styal-desktop/${environment.appVersion}`,
        }),
      ),
    );
    if (response.status === 404) return null;
    if (response.status !== 200) {
      return yield* new DesktopPreviewAppLookupError({ status: response.status, url });
    }
    return yield* response.json;
  }, Effect.timeout(GITHUB_LOOKUP_TIMEOUT));

  const fetchReleaseAssets = Effect.gen(function* () {
    const body = yield* getGitHubJson(`${API_ROOT}/releases/tags/${RELEASE_TAG}`);
    const assets = body === null ? [] : (yield* decodeRelease(body)).assets;
    const fetchedAt = yield* Clock.currentTimeMillis;
    yield* Ref.set(lastReleaseRef, { assets, fetchedAt });
    return assets;
  });

  const findBuild: DesktopPreviewApp["Service"]["findBuild"] = Effect.fn(
    "DesktopPreviewApp.findBuild",
  )(function* (pullRequestNumber) {
    if (!supported) return { build: null, lookupFailed: false };
    const last = yield* Ref.get(lastReleaseRef);
    const now = yield* Clock.currentTimeMillis;
    const reusable = last !== null && now - last.fetchedAt < RELEASE_LOOKUP_REUSE_MS;
    const looked = reusable
      ? { assets: last.assets, lookupFailed: false }
      : yield* fetchReleaseAssets.pipe(
          Effect.map((assets) => ({ assets, lookupFailed: false })),
          Effect.catch((error) =>
            logWarning("preview build lookup failed", { error: String(error) }).pipe(
              Effect.as({ assets: last?.assets ?? [], lookupFailed: true }),
            ),
          ),
        );
    const asset = selectPreviewAsset(looked.assets, pullRequestNumber);
    return {
      build:
        asset === null
          ? null
          : {
              pullRequestNumber: asset.pullRequestNumber,
              runNumber: asset.runNumber,
              version: asset.version,
              sizeBytes: asset.sizeBytes,
              publishedAt: asset.publishedAt,
            },
      lookupFailed: looked.lookupFailed,
    };
  });

  const download = Effect.fn("DesktopPreviewApp.download")(function* (
    asset: PreviewAppAsset,
    destination: string,
  ) {
    const failure = (cause: unknown) =>
      fail("download", `Could not download the preview build: ${String(cause)}`);
    const response = yield* http
      .execute(
        HttpClientRequest.get(`${DOWNLOAD_ROOT}/${encodeURIComponent(asset.assetName)}`).pipe(
          HttpClientRequest.setHeader("user-agent", `styal-desktop/${environment.appVersion}`),
        ),
      )
      .pipe(Effect.mapError(failure));
    if (response.status !== 200) {
      return yield* failure(`GitHub answered ${response.status}`);
    }
    const hash = NodeCrypto.createHash("sha256");
    let received = 0;
    let reported = 0;
    yield* response.stream.pipe(
      Stream.mapError(failure),
      Stream.tap((chunk) => {
        hash.update(chunk);
        received += chunk.byteLength;
        const progress = Math.min(99, Math.floor((received / asset.sizeBytes) * 100));
        if (progress === reported) return Effect.void;
        reported = progress;
        return setActivity({
          status: "installing",
          pullRequestNumber: asset.pullRequestNumber,
          phase: "downloading",
          progress,
        });
      }),
      Stream.run(fs.sink(destination)),
      Effect.mapError(failure),
    );
    if (hash.digest("hex") !== asset.sha256) {
      return yield* fail(
        "digest_mismatch",
        "The downloaded build does not match the digest GitHub published for it, so it was discarded.",
      );
    }
  });

  const detach = (force: boolean) =>
    run("/usr/bin/hdiutil", ["detach", mountPoint, ...(force ? ["-force"] : [])]).pipe(
      Effect.ignore,
    );

  // Anything other than a clear answer counts as mounted, so removal never walks into a volume.
  const isMounted = run("/sbin/mount", []).pipe(
    Effect.map((result) => result.exitCode !== 0 || result.stdout.includes(` on ${mountPoint} (`)),
    Effect.orElseSucceed(() => true),
  );

  const ensureDetached = Effect.gen(function* () {
    if (!(yield* isMounted)) return true;
    yield* detach(false);
    if (!(yield* isMounted)) return true;
    yield* detach(true);
    return !(yield* isMounted);
  });

  // Returns whether the directory is gone. An empty install location means an install stopped
  // between its renames, so the backup goes back first, whatever else is stuck. It is kept while
  // a failed rollback leaves it as the only good copy.
  const cleanStaging = Effect.gen(function* () {
    if (!(yield* exists(stagingDirectory))) return true;
    if ((yield* exists(previousAppPath)) && !(yield* exists(installedAppPath))) {
      const restored = yield* fs.rename(previousAppPath, installedAppPath).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          logWarning("could not restore the previous preview", { error: String(error) }).pipe(
            Effect.as(false),
          ),
        ),
      );
      if (!restored) return false;
    }
    if (yield* Ref.get(keepBackupRef)) return false;
    if ((yield* exists(mountPoint)) && !(yield* ensureDetached)) {
      yield* logWarning("preview build is still mounted; leaving staging in place");
      return false;
    }
    return yield* fs.remove(stagingDirectory, { recursive: true, force: true }).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        logWarning("could not clean preview staging", { error: String(error) }).pipe(
          Effect.as(false),
        ),
      ),
    );
  }).pipe(Effect.uninterruptible);

  const copyAppOutOfDmg = Effect.fn("DesktopPreviewApp.copyAppOutOfDmg")(function* (
    dmg: string,
    destination: string,
  ) {
    yield* fs
      .makeDirectory(mountPoint, { recursive: true })
      .pipe(Effect.mapError((cause) => fail("mount", `Could not prepare the mount: ${cause}`)));
    yield* Effect.acquireRelease(
      run("/usr/bin/hdiutil", [
        "attach",
        dmg,
        "-nobrowse",
        "-noautoopen",
        "-readonly",
        "-mountpoint",
        mountPoint,
      ]).pipe(
        Effect.mapError((cause) => fail("mount", `Could not mount the build: ${cause}`)),
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.void
            : Effect.fail(fail("mount", `Could not mount the build: ${result.stderr.trim()}`)),
        ),
      ),
      () => ensureDetached,
    );
    const source = path.join(mountPoint, APP_BUNDLE_NAME);
    if (!(yield* exists(source))) {
      return yield* fail("wrong_app", `The build does not contain ${APP_BUNDLE_NAME}.`);
    }
    const copied = yield* run("/usr/bin/ditto", [source, destination]).pipe(
      Effect.mapError((cause) => fail("copy", `Could not copy the app: ${cause}`)),
    );
    if (copied.exitCode !== 0) {
      return yield* fail("copy", `Could not copy the app: ${copied.stderr.trim()}`);
    }
  }, Effect.scoped);

  // Identity decides the state directory, so a build must be what it claims before it runs.
  const verifyStagedApp = Effect.fn("DesktopPreviewApp.verifyStagedApp")(function* (
    appPath: string,
    asset: PreviewAppAsset,
  ) {
    const { identifier, version } = yield* readBundle(appPath);
    if (identifier !== PREVIEW_IDENTITY.appUserModelId || version !== asset.version) {
      return yield* fail(
        "wrong_app",
        `The build identifies as ${identifier ?? "unknown"} ${version ?? "unknown"}, not the preview ${asset.version}, so it was not installed.`,
      );
    }
    // Recursive, because a nested bundle or the executable can carry the attribute on its own.
    const attributes = yield* run("/usr/bin/xattr", ["-r", "-s", appPath]).pipe(
      Effect.mapError((cause) =>
        fail("quarantine_check", `Could not read the build's attributes: ${cause}`),
      ),
    );
    if (attributes.exitCode !== 0) {
      return yield* fail(
        "quarantine_check",
        `Could not read the build's attributes, so it was not installed: ${attributes.stderr.trim()}`,
      );
    }
    const quarantined = attributes.stdout.includes(QUARANTINE_ATTRIBUTE);
    yield* logInfo("checked preview build for quarantine", { quarantined });
    if (quarantined) {
      return yield* fail(
        "quarantined",
        `macOS put ${QUARANTINE_ATTRIBUTE} on this build, so it was not installed. Use the DMG link and xattr command from the pull request's preview comment.`,
      );
    }
  });

  const listRunningPreviewApps = run("/bin/ps", ["-axww", "-o", "pid=,ppid=,comm="]).pipe(
    Effect.mapError((cause) =>
      fail("quit_timeout", `Could not check whether the preview is running: ${cause}`),
    ),
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(parseRunningPreviewApps(result.stdout))
        : Effect.fail(
            fail(
              "quit_timeout",
              `Could not check whether the preview is running: ${result.stderr}`,
            ),
          ),
    ),
  );

  const quitRunningPreview = Effect.gen(function* () {
    const running = yield* listRunningPreviewApps;
    if (running.all.length === 0) return;
    // Electron treats SIGTERM as a normal quit. Never escalate: the app may hold unsaved work.
    yield* Effect.forEach(running.roots, (pid) =>
      run("/bin/kill", ["-TERM", String(pid)]).pipe(Effect.ignore),
    );
    for (let attempt = 0; ; attempt += 1) {
      if ((yield* listRunningPreviewApps).all.length === 0) return;
      if (attempt >= quitPolls) break;
      yield* Effect.sleep(QUIT_POLL_INTERVAL);
    }
    return yield* fail(
      "quit_timeout",
      "styal (Preview) did not quit. Quit it yourself, then try again.",
    );
  });

  // The slot only ever holds the preview identity; anything else there is left alone.
  const ensureSlotIsOurs = Effect.gen(function* () {
    if (!(yield* exists(installedAppPath))) return;
    if ((yield* readInstalled) === null) {
      return yield* fail(
        "slot_occupied",
        `${installedAppPath} is not a styal preview, so it was left in place. Move it and try again.`,
      );
    }
  });

  const openInstalledApp = Effect.gen(function* () {
    const opened = yield* run("/usr/bin/open", [installedAppPath]).pipe(
      Effect.mapError((cause) => fail("open", `Could not open the preview: ${cause}`)),
    );
    if (opened.exitCode !== 0) {
      return yield* fail("open", `Could not open the preview: ${opened.stderr.trim()}`);
    }
  });

  // Runs to its end once started. Any failure leaves the install location empty, and cleanStaging
  // puts the backup back. A build macOS refuses to open is moved out so the same happens to it.
  const commitInstall = Effect.fn("DesktopPreviewApp.commitInstall")(function* (stagedApp: string) {
    const failure = (cause: unknown) =>
      fail("replace", `Could not install the app in ${applicationsDirectory}: ${String(cause)}`);
    if (yield* exists(installedAppPath)) {
      yield* fs.rename(installedAppPath, previousAppPath).pipe(Effect.mapError(failure));
    }
    yield* fs.rename(stagedApp, installedAppPath).pipe(Effect.mapError(failure));
    if (!runningAsPreview) {
      yield* openInstalledApp.pipe(
        Effect.tapError(() =>
          fs
            .rename(installedAppPath, path.join(stagingDirectory, "rejected.app"))
            .pipe(
              Effect.catch((cause) =>
                Ref.set(keepBackupRef, true).pipe(
                  Effect.andThen(
                    logWarning("could not move the rejected preview out", { error: String(cause) }),
                  ),
                ),
              ),
            ),
        ),
      );
    }
  }, Effect.uninterruptible);

  const confirm = Effect.fn("DesktopPreviewApp.confirm")(
    function* (input: {
      readonly action: string;
      readonly message: string;
      readonly detail: string;
    }) {
      // On macOS a box without an owner runs modally and blocks the main process until answered.
      const owner = yield* electronWindow.focusedMainOrFirst;
      if (Option.isNone(owner)) return false;
      const { response } = yield* electronDialog.showMessageBox(
        {
          type: "warning",
          buttons: [input.action, "Cancel"],
          // Default to Cancel so an Enter typed while the box appears cannot accept it.
          defaultId: 1,
          cancelId: 1,
          message: input.message,
          detail: input.detail,
        },
        owner.value,
      );
      return response === 0;
    },
    Effect.orElseSucceed(() => false),
  );

  const runAction = Effect.fn("DesktopPreviewApp.runAction")(function* (
    action: "install" | "open" | "remove" | "reset",
    source: "user" | "system",
    activity: DesktopPreviewAppActivity,
    body: Effect.Effect<void | "skipped", DesktopPreviewAppError>,
  ) {
    const report = (
      outcome: DesktopPreviewAppActionResult["outcome"],
      failureReason?: DesktopPreviewAppFailureReason,
    ) =>
      telemetry.publishFeatureUsage({
        version: 1,
        type: "desktopFeatureUsage",
        feature: "desktop-preview-app",
        action,
        source,
        outcome,
        ...(failureReason === undefined ? {} : { failureReason }),
      });
    const claimed = yield* Ref.modify(activityRef, (current) =>
      current.status === "idle" ? ([true, activity] as const) : ([false, current] as const),
    );
    if (!claimed) {
      yield* report("failed", "busy");
      return {
        outcome: "failed",
        message: "Another preview action is still running.",
        state: yield* state,
      } satisfies DesktopPreviewAppActionResult;
    }
    yield* publishState;
    const fiber = yield* body.pipe(Effect.forkIn(scope));
    if (action === "install") yield* Ref.set(installFiberRef, fiber);
    const exit = yield* Fiber.await(fiber);
    yield* Ref.set(installFiberRef, null);
    yield* Ref.set(activityRef, IDLE);
    yield* publishState;

    if (Exit.isSuccess(exit)) {
      if (exit.value !== "skipped") yield* report("completed");
      return {
        outcome: "completed",
        message: null,
        state: yield* state,
      } satisfies DesktopPreviewAppActionResult;
    }
    const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error;
    if (error === undefined) {
      const defect = exit.cause.reasons.find((reason) => reason._tag === "Die");
      if (defect === undefined) {
        yield* report("cancelled");
        return {
          outcome: "cancelled",
          message: null,
          state: yield* state,
        } satisfies DesktopPreviewAppActionResult;
      }
      yield* logWarning("preview action died", { action, defect: String(defect.defect) });
      yield* report("failed", "unexpected");
      return {
        outcome: "failed",
        message: "The preview action stopped unexpectedly. Check the desktop log.",
        state: yield* state,
      } satisfies DesktopPreviewAppActionResult;
    }
    yield* logWarning("preview action failed", { action, reason: error.reason });
    yield* report("failed", error.reason);
    return {
      outcome: "failed",
      message: error.message,
      state: yield* state,
    } satisfies DesktopPreviewAppActionResult;
  });

  const install: DesktopPreviewApp["Service"]["install"] = (pullRequestNumber) =>
    runAction(
      "install",
      "user",
      { status: "installing", pullRequestNumber, phase: "confirming", progress: null },
      Effect.gen(function* () {
        if (!supported) {
          return yield* fail("unsupported", "Preview builds need an Apple Silicon Mac.");
        }
        if (runningFromInstalledApp) {
          return yield* fail(
            "not_allowed",
            "This preview cannot replace itself. Use your main styal app.",
          );
        }
        yield* ensureSlotIsOurs;
        const assets = yield* fetchReleaseAssets.pipe(
          Effect.mapError((cause) =>
            fail("no_build", `Could not look up the preview build: ${String(cause)}`),
          ),
        );
        const asset = selectPreviewAsset(assets, pullRequestNumber);
        if (asset === null) {
          return yield* fail(
            "no_build",
            `Pull request #${pullRequestNumber} has no preview build.`,
          );
        }
        const installed = yield* readInstalled;
        const action = runningAsPreview ? "Install" : "Install and open";
        const confirmed = yield* confirm({
          action,
          message: `${action} pull request #${pullRequestNumber}'s preview?`,
          detail: [
            `Build ${asset.runNumber} is unsigned.`,
            ...(installed === null
              ? []
              : [
                  `It replaces pull request #${installed.pullRequestNumber}, build ${installed.runNumber}.`,
                ]),
          ].join(" "),
        });
        if (!confirmed) return yield* Effect.interrupt;
        yield* setActivity({
          status: "installing",
          pullRequestNumber,
          phase: "downloading",
          progress: 0,
        });

        if (!(yield* cleanStaging)) {
          return yield* fail(
            "mount",
            `An earlier preview install is still attached at ${mountPoint}. Eject it and try again.`,
          );
        }
        yield* Effect.gen(function* () {
          yield* fs
            .makeDirectory(stagingDirectory, { recursive: true })
            .pipe(
              Effect.mapError((cause) =>
                fail("download", `Could not prepare ${stagingDirectory}: ${cause}`),
              ),
            );
          const dmg = path.join(stagingDirectory, asset.assetName);
          const stagedApp = path.join(stagingDirectory, APP_BUNDLE_NAME);
          yield* download(asset, dmg);

          const phase = (next: "copying" | "quitting" | "opening") =>
            setActivity({
              status: "installing",
              pullRequestNumber,
              phase: next,
              progress: null,
            });
          yield* phase("copying");
          yield* copyAppOutOfDmg(dmg, stagedApp);
          yield* fs.remove(dmg, { force: true }).pipe(Effect.ignore);
          yield* verifyStagedApp(stagedApp, asset);

          // A preview app cannot quit and reopen its own identity, so it stops once installed.
          if (!runningAsPreview) {
            yield* phase("quitting");
            yield* quitRunningPreview;
            yield* phase("opening");
          }
          // Past this point cancelling would leave the app installed but report it as cancelled.
          yield* Ref.set(installFiberRef, null);
          yield* commitInstall(stagedApp);
        }).pipe(Effect.ensuring(cleanStaging));
      }),
    );

  const cancelInstall: DesktopPreviewApp["Service"]["cancelInstall"] = Effect.gen(function* () {
    const fiber = yield* Ref.get(installFiberRef);
    if (fiber !== null) yield* Fiber.interrupt(fiber).pipe(Effect.asVoid);
  });

  const open: DesktopPreviewApp["Service"]["open"] = runAction(
    "open",
    "user",
    { status: "opening" },
    Effect.gen(function* () {
      if (runningAsPreview) {
        return yield* fail("not_allowed", "Open the preview from your main styal app.");
      }
      if ((yield* readInstalled) === null) {
        return yield* fail("open", "No preview is installed.");
      }
      yield* openInstalledApp;
    }),
  );

  // Rename first, so a failed removal puts the whole app back instead of leaving half of it.
  const moveInstalledAppOut = Effect.gen(function* () {
    yield* fs.makeDirectory(stagingDirectory, { recursive: true });
    yield* fs.rename(installedAppPath, previousAppPath);
    yield* fs.remove(previousAppPath, { recursive: true, force: true });
  }).pipe(
    Effect.mapError((cause) => fail("remove", `Could not remove the preview: ${cause}`)),
    Effect.ensuring(cleanStaging),
  );

  const removeBody = Effect.gen(function* () {
    if (runningFromInstalledApp) {
      return yield* fail(
        "not_allowed",
        "This preview cannot remove itself. Use your main styal app.",
      );
    }
    yield* ensureSlotIsOurs;
    if (!runningAsPreview) yield* quitRunningPreview;
    yield* moveInstalledAppOut;
  });

  const remove: DesktopPreviewApp["Service"]["remove"] = runAction(
    "remove",
    "user",
    { status: "removing" },
    removeBody,
  );

  // Another install can be configured to use this directory as its own home, and it would not show
  // up as a preview process. Its server publishes a runtime record that names its process.
  const ensureNoServerUsesPreviewData = Effect.gen(function* () {
    const previewHome = previewDataDirectories[0]!;
    for (const stateDirectory of ["userdata", "dev"]) {
      const record = yield* fs
        .readFileString(path.join(previewHome, stateDirectory, "server-runtime.json"))
        .pipe(
          Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ServerRuntimeRecord))),
          Effect.option,
        );
      if (Option.isNone(record)) continue;
      const alive = yield* run("/bin/kill", ["-0", String(record.value.pid)]).pipe(
        Effect.map((result) => result.exitCode === 0),
        Effect.orElseSucceed(() => true),
      );
      if (alive) {
        return yield* fail(
          "reset",
          `A styal server (process ${record.value.pid}) is still using ${previewHome}, so nothing was deleted. Stop it and try again.`,
        );
      }
    }
  });

  const resetData: DesktopPreviewApp["Service"]["resetData"] = runAction(
    "reset",
    "user",
    { status: "resetting" },
    Effect.gen(function* () {
      if (!supported || runningAsPreview) {
        return yield* fail("not_allowed", "Reset preview data from your main styal app.");
      }
      const confirmed = yield* confirm({
        action: "Reset preview data",
        message: "Reset preview data?",
        detail:
          "This quits styal (Preview) and deletes its projects, threads, settings, and sign-ins. Your main styal app is not affected.",
      });
      if (!confirmed) return yield* Effect.interrupt;
      yield* quitRunningPreview;
      yield* ensureNoServerUsesPreviewData;
      yield* Effect.forEach(previewDataDirectories, (directory) =>
        fs.remove(directory, { recursive: true, force: true }),
      ).pipe(Effect.mapError((cause) => fail("reset", `Could not reset preview data: ${cause}`)));
    }),
  );

  const removeIfPullRequestClosed: DesktopPreviewApp["Service"]["removeIfPullRequestClosed"] =
    Effect.gen(function* () {
      if ((yield* Ref.get(activityRef)).status !== "idle") return;
      const checked = yield* readInstalled;
      if (checked === null) return;
      const body = yield* getGitHubJson(`${API_ROOT}/pulls/${checked.pullRequestNumber}`);
      if (body === null) return;
      const pullRequest = yield* decodePullRequest(body);
      if (pullRequest.state !== "closed") return;
      yield* runAction(
        "remove",
        "system",
        { status: "removing" },
        // Decided while holding the action, because the installed build can change during the lookup.
        Effect.gen(function* () {
          if ((yield* readInstalled)?.version !== checked.version) return "skipped" as const;
          // Leave a build someone is still testing; the next check removes it.
          if ((yield* listRunningPreviewApps).all.length > 0) return "skipped" as const;
          yield* moveInstalledAppOut;
        }),
      );
    }).pipe(
      Effect.catch((error) =>
        logWarning("could not check the preview's pull request", { error: String(error) }),
      ),
    );

  return DesktopPreviewApp.of({
    state,
    findBuild,
    install,
    cancelInstall,
    open,
    remove,
    resetData,
    removeIfPullRequestClosed,
    cleanLeftovers: supported ? cleanStaging.pipe(Effect.asVoid) : Effect.void,
    managesInstalledApp: supported && environment.installVariant === "production",
  });
});

export const layer = Layer.effect(
  DesktopPreviewApp,
  Effect.gen(function* () {
    const service = yield* make();
    // Before any action can start, because an action owns the staging directory while it runs.
    yield* service.cleanLeftovers;
    if (service.managesInstalledApp) {
      yield* service.removeIfPullRequestClosed.pipe(
        Effect.repeat(Schedule.spaced(CLOSED_PULL_REQUEST_CHECK_INTERVAL)),
        Effect.forkScoped,
      );
    }
    return service;
  }),
);
