// @effect-diagnostics nodeBuiltinImport:off -- The download is hashed as it streams, and Effect's Crypto only digests a whole buffer.
import {
  DESKTOP_PREVIEW_APP_REPOSITORY,
  DesktopPreviewAppFailureReason,
  type DesktopPreviewAppActionResult,
  type DesktopPreviewAppActivity,
  type DesktopPreviewAppBuild,
  type DesktopPreviewAppState,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";

// Installs a pull request's unsigned macOS build as `styal (Preview)` after a person's click.
// The app in ~/Applications is the only record of what is installed. Files this process writes
// should not be quarantined; a build that is fails with `quarantined` and is never stripped.

const RELEASE_TAG = "desktop-preview";
const API_ROOT = `https://api.github.com/repos/${DESKTOP_PREVIEW_APP_REPOSITORY}`;
const DOWNLOAD_ROOT = `https://github.com/${DESKTOP_PREVIEW_APP_REPOSITORY}/releases/download/${RELEASE_TAG}`;
const APP_BUNDLE_NAME = "styal (Preview).app";
const PREVIEW_IDENTITY = DESKTOP_INSTALL_IDENTITIES.preview;
const STAGING_DIRECTORY_NAME = ".styal-preview-install";
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
    readonly findBuild: (pullRequestNumber: number) => Effect.Effect<DesktopPreviewAppBuild | null>;
    readonly install: (pullRequestNumber: number) => Effect.Effect<DesktopPreviewAppActionResult>;
    readonly cancelInstall: Effect.Effect<void>;
    readonly open: Effect.Effect<DesktopPreviewAppActionResult>;
    readonly remove: Effect.Effect<DesktopPreviewAppActionResult>;
    readonly resetData: Effect.Effect<DesktopPreviewAppActionResult>;
    /** Removes the installed preview if its pull request has closed and the app is not running. */
    readonly removeIfPullRequestClosed: Effect.Effect<void>;
    /** Whatever a crash left in the staging directory, including an attached DMG. */
    readonly cleanLeftovers: Effect.Effect<void>;
    /** False in a preview app, which leaves the installed app to the main styal app. */
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
  const telemetry = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
  const scope = yield* Scope.Scope;
  const { path } = environment;

  const supported = environment.platform === "darwin" && environment.processArch === "arm64";
  const runningAsPreview = environment.installVariant === "preview";
  const quitPolls = options?.quitPolls ?? DEFAULT_QUIT_POLLS;

  const applicationsDirectory = path.join(environment.homeDirectory, "Applications");
  const installedAppPath = path.join(applicationsDirectory, APP_BUNDLE_NAME);
  // Beside the install location, so the final rename stays on one volume.
  const stagingDirectory = path.join(applicationsDirectory, STAGING_DIRECTORY_NAME);
  const mountPoint = path.join(stagingDirectory, "mount");
  const runningFromInstalledApp = environment.appPath.startsWith(`${installedAppPath}/`);
  const previewDataDirectories = [
    path.join(environment.baseDir, PREVIEW_IDENTITY.homeDirName ?? "preview"),
    path.join(environment.appDataDirectory, PREVIEW_IDENTITY.slug),
  ];

  const activityRef = yield* Ref.make<DesktopPreviewAppActivity>(IDLE);
  const lastStateRef = yield* Ref.make<DesktopPreviewAppState | null>(null);
  const installFiberRef = yield* Ref.make<Fiber.Fiber<void, DesktopPreviewAppError> | null>(null);
  const conditionalResponses = new Map<string, { etag: string; body: unknown }>();

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
    const cached = conditionalResponses.get(url);
    const response = yield* http.execute(
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeaders({
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": `styal-desktop/${environment.appVersion}`,
          ...(cached === undefined ? {} : { "if-none-match": cached.etag }),
        }),
      ),
    );
    if (response.status === 304 && cached !== undefined) return cached.body;
    if (response.status === 404) return null;
    if (response.status !== 200) {
      return yield* new DesktopPreviewAppLookupError({ status: response.status, url });
    }
    const body: unknown = yield* response.json;
    const etag = response.headers.etag;
    if (etag !== undefined) conditionalResponses.set(url, { etag, body });
    return body;
  });

  const lookUpAsset = Effect.fn("DesktopPreviewApp.lookUpAsset")(function* (
    pullRequestNumber: number,
  ) {
    const body = yield* getGitHubJson(`${API_ROOT}/releases/tags/${RELEASE_TAG}`);
    if (body === null) return null;
    const release = yield* decodeRelease(body);
    return selectPreviewAsset(release.assets, pullRequestNumber);
  });

  const findBuild: DesktopPreviewApp["Service"]["findBuild"] = (pullRequestNumber) =>
    !supported
      ? Effect.succeed(null)
      : lookUpAsset(pullRequestNumber).pipe(
          Effect.map((asset) =>
            asset === null
              ? null
              : {
                  pullRequestNumber: asset.pullRequestNumber,
                  runNumber: asset.runNumber,
                  version: asset.version,
                  sizeBytes: asset.sizeBytes,
                  publishedAt: asset.publishedAt,
                },
          ),
          Effect.catch((error) =>
            logWarning("preview build lookup failed", { error: String(error) }).pipe(
              Effect.as(null),
            ),
          ),
        );

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
      Effect.map((result) => result.exitCode === 0),
      Effect.orElseSucceed(() => false),
    );

  const cleanStaging = Effect.gen(function* () {
    if (!(yield* exists(stagingDirectory))) return;
    // A crash can leave the volume attached, and removal must not walk into it.
    if ((yield* exists(mountPoint)) && !(yield* detach(false))) yield* detach(true);
    yield* fs
      .remove(stagingDirectory, { recursive: true, force: true })
      .pipe(
        Effect.catch((error) =>
          logWarning("could not clean preview staging", { error: String(error) }),
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
      () =>
        detach(false).pipe(
          Effect.flatMap((detached) => (detached ? Effect.void : detach(true))),
          Effect.asVoid,
        ),
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
    const quarantine = yield* run("/usr/bin/xattr", ["-p", QUARANTINE_ATTRIBUTE, appPath]).pipe(
      Effect.mapError((cause) => fail("quarantined", `Could not read its attributes: ${cause}`)),
    );
    const quarantined = quarantine.exitCode === 0;
    yield* logInfo("checked preview build for quarantine", { quarantined });
    if (quarantined) {
      return yield* fail(
        "quarantined",
        `macOS put ${QUARANTINE_ATTRIBUTE} on this build, so it was not installed. Use the DMG link and xattr command from the pull request's preview comment.`,
      );
    }
  });

  const listRunningPreviewApps = run("/bin/ps", ["-axww", "-o", "pid=,ppid=,comm="]).pipe(
    Effect.map((result) => parseRunningPreviewApps(result.stdout)),
    Effect.mapError((cause) =>
      fail("quit_timeout", `Could not check whether the preview is running: ${cause}`),
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

  const replaceInstalledApp = Effect.fn("DesktopPreviewApp.replaceInstalledApp")(function* (
    stagedApp: string,
  ) {
    const failure = (cause: unknown) =>
      fail("replace", `Could not install the app in ${applicationsDirectory}: ${String(cause)}`);
    const previous = path.join(stagingDirectory, "previous.app");
    const hadPrevious = yield* exists(installedAppPath);
    if (hadPrevious) {
      yield* fs.rename(installedAppPath, previous).pipe(Effect.mapError(failure));
    }
    yield* fs.rename(stagedApp, installedAppPath).pipe(
      Effect.mapError(failure),
      Effect.tapError(() =>
        hadPrevious ? fs.rename(previous, installedAppPath).pipe(Effect.ignore) : Effect.void,
      ),
    );
  }, Effect.uninterruptible);

  const openInstalledApp = Effect.gen(function* () {
    const opened = yield* run("/usr/bin/open", [installedAppPath]).pipe(
      Effect.mapError((cause) => fail("open", `Could not open the preview: ${cause}`)),
    );
    if (opened.exitCode !== 0) {
      return yield* fail("open", `Could not open the preview: ${opened.stderr.trim()}`);
    }
  });

  const runAction = Effect.fn("DesktopPreviewApp.runAction")(function* (
    action: "install" | "open" | "remove" | "reset",
    source: "user" | "system",
    activity: DesktopPreviewAppActivity,
    body: Effect.Effect<void, DesktopPreviewAppError>,
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
      yield* report("completed");
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
      { status: "installing", pullRequestNumber, phase: "downloading", progress: 0 },
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
        const asset = yield* lookUpAsset(pullRequestNumber).pipe(
          Effect.mapError((cause) =>
            fail("no_build", `Could not look up the preview build: ${String(cause)}`),
          ),
        );
        if (asset === null) {
          return yield* fail(
            "no_build",
            `Pull request #${pullRequestNumber} has no preview build.`,
          );
        }

        yield* cleanStaging;
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
          }
          yield* replaceInstalledApp(stagedApp);
          if (!runningAsPreview) {
            yield* phase("opening");
            yield* openInstalledApp;
          }
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

  const removeBody = Effect.gen(function* () {
    if (runningFromInstalledApp) {
      return yield* fail(
        "not_allowed",
        "This preview cannot remove itself. Use your main styal app.",
      );
    }
    yield* ensureSlotIsOurs;
    if (!runningAsPreview) yield* quitRunningPreview;
    // Rename first, so a failed removal cannot leave a half-deleted app in the slot.
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(stagingDirectory, { recursive: true });
      yield* fs.rename(installedAppPath, path.join(stagingDirectory, "previous.app"));
    }).pipe(
      Effect.mapError((cause) => fail("remove", `Could not remove the preview: ${cause}`)),
      Effect.ensuring(cleanStaging),
    );
  });

  const remove: DesktopPreviewApp["Service"]["remove"] = runAction(
    "remove",
    "user",
    { status: "removing" },
    removeBody,
  );

  const resetData: DesktopPreviewApp["Service"]["resetData"] = runAction(
    "reset",
    "user",
    { status: "resetting" },
    Effect.gen(function* () {
      if (!supported || runningAsPreview) {
        return yield* fail("not_allowed", "Reset preview data from your main styal app.");
      }
      yield* quitRunningPreview;
      yield* Effect.forEach(previewDataDirectories, (directory) =>
        fs.remove(directory, { recursive: true, force: true }),
      ).pipe(Effect.mapError((cause) => fail("reset", `Could not reset preview data: ${cause}`)));
    }),
  );

  const removeIfPullRequestClosed: DesktopPreviewApp["Service"]["removeIfPullRequestClosed"] =
    Effect.gen(function* () {
      if ((yield* Ref.get(activityRef)).status !== "idle") return;
      const installed = yield* readInstalled;
      if (installed === null) return;
      const body = yield* getGitHubJson(`${API_ROOT}/pulls/${installed.pullRequestNumber}`);
      if (body === null) return;
      const pullRequest = yield* decodePullRequest(body);
      if (pullRequest.state !== "closed") return;
      // Leave a build someone is still testing; the next check removes it.
      if ((yield* listRunningPreviewApps).all.length > 0) return;
      yield* runAction("remove", "system", { status: "removing" }, removeBody);
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
    cleanLeftovers: supported ? cleanStaging : Effect.void,
    managesInstalledApp: supported && !runningAsPreview,
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
