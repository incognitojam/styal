// @effect-diagnostics nodeBuiltinImport:off -- Fixtures hash their DMG bytes the way GitHub publishes them.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import type * as Electron from "electron";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopManagedPolicy from "../app/DesktopManagedPolicy.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopPreviewApp from "./DesktopPreviewApp.ts";

const APP = "styal (Preview).app";
const PREVIEW_ID = "build.styal.app.preview";
const DMG_BYTES = new TextEncoder().encode("fake dmg contents");
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const asset = (name: string, overrides: Record<string, unknown> = {}) => ({
  name,
  size: DMG_BYTES.byteLength,
  state: "uploaded",
  digest: `sha256:${sha256(DMG_BYTES)}`,
  updated_at: "2026-11-05T10:00:00Z",
  ...overrides,
});

describe("selectPreviewAsset", () => {
  it("picks this pull request's newest finished DMG and nothing else", () => {
    const assets = [
      asset("styal-1.2.3-pr.123.9-arm64.dmg"),
      asset("styal-1.2.3-pr.12.5-arm64.dmg"),
      asset("styal-1.2.3-pr.12.7-arm64.dmg"),
      asset("styal-1.2.3-pr.12.8-arm64.dmg", { state: "starter" }),
      asset("styal-1.2.3-pr.12.9-arm64.dmg", { digest: null }),
      asset("styal-1.2.3-pr.12.10-x64.exe"),
      asset("evil-1.2.3-pr.12.11-arm64.dmg"),
    ];
    const selected = DesktopPreviewApp.selectPreviewAsset(assets, 12);
    assert.strictEqual(selected?.assetName, "styal-1.2.3-pr.12.7-arm64.dmg");
    assert.strictEqual(selected?.version, "1.2.3-pr.12.7");
    assert.strictEqual(DesktopPreviewApp.selectPreviewAsset(assets, 1), null);
  });
});

describe("parseRunningPreviewApps", () => {
  it("signals only root apps, wherever they run, and waits for their children too", () => {
    const running = DesktopPreviewApp.parseRunningPreviewApps(
      [
        `  100     1 /Users/me/Applications/${APP}/Contents/MacOS/styal (Preview)`,
        `  101   100 /Users/me/Applications/${APP}/Contents/MacOS/styal (Preview)`,
        `  102   100 /Users/me/Applications/${APP}/Contents/Frameworks/styal (Preview) Helper.app/Contents/MacOS/styal (Preview) Helper`,
        `  200     1 /Volumes/styal/${APP}/Contents/MacOS/styal (Preview)`,
        "  300     1 /Applications/styal.app/Contents/MacOS/styal",
      ].join("\n"),
    );
    assert.deepStrictEqual(running.roots, [100, 200]);
    assert.deepStrictEqual(running.all, [100, 101, 200]);
  });
});

interface Scenario {
  readonly variant?: "production" | "preview";
  readonly platform?: NodeJS.Platform;
  readonly assets?: ReadonlyArray<ReturnType<typeof asset>>;
  readonly pullRequestState?: string;
  readonly downloadBytes?: Uint8Array;
  readonly attachExitCode?: number;
  readonly openExitCode?: number;
  /** Bundle written into the fake DMG; defaults to the asset's preview identity. */
  readonly dmgBundle?: { readonly identifier: string; readonly version: string };
  readonly dmgHasApp?: boolean;
  readonly quarantined?: boolean;
  /** A preview already running: one that quits when signalled, or one that does not. */
  readonly runningPreview?: "quits" | "stuck";
  readonly appPath?: string;
  readonly runningFromSlot?: boolean;
  /** Completed once the download starts; the download then never finishes. */
  readonly downloadStarted?: Deferred.Deferred<void>;
  /** The person's answer to the main-process confirmation. */
  readonly confirmed?: boolean;
  readonly policy?: ManagedPolicyDocument;
  readonly detachFails?: boolean;
  readonly psFails?: boolean;
  readonly xattrFails?: boolean;
  /** An attribute listing for a nested file, as `xattr -r` prints it. */
  readonly xattrOutput?: string;
  /** Another install replaces the app while the closed pull request lookup is in flight. */
  readonly installedDuringLookup?: string;
  readonly slotDuringDownload?: "foreign" | "folder";
  readonly releaseStatus?: number;
  /** Completed once GitHub starts answering the lookup; the answer then never finishes. */
  readonly releaseStalled?: Deferred.Deferred<void>;
  /** The rejected build cannot be moved out of the install location. */
  readonly rejectedRenameFails?: boolean;
  readonly noWindow?: boolean;
  readonly plutilFails?: boolean;
  readonly plistStatFails?: boolean;
  readonly symlinkApplications?: boolean;
  readonly fault?: "backup" | "promote" | "cleanup" | "remove" | "copy" | "retire";
}

const writeBundle = (appPath: string, bundle: { identifier: string; version: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.join(appPath, "Contents"), { recursive: true });
    yield* fs.writeFileString(
      path.join(appPath, "Contents", "Info.plist"),
      JSON.stringify({ ...bundle, executable: "styal" }),
    );
    yield* fs.makeDirectory(path.join(appPath, "Contents", "MacOS"), { recursive: true });
    yield* fs.writeFileString(path.join(appPath, "Contents", "MacOS", "styal"), "executable");
    yield* fs.makeDirectory(path.join(appPath, "Contents", "Resources"), { recursive: true });
    yield* fs.writeFileString(path.join(appPath, "Contents", "Resources", "app.asar"), "resources");
  });

const output = (text: string) => Stream.make(new TextEncoder().encode(text));

// Fault-injected filesystem operations use isolated bundles; macOS tools and GitHub are faked.
const setup = (scenario: Scenario) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "preview-install-test-" });
    const baseDir = path.join(home, ".styal");
    const appData = path.join(home, "Library", "Application Support");
    if (scenario.symlinkApplications) {
      const target = path.join(home, "real-applications");
      yield* fs.makeDirectory(target);
      yield* fs.symlink(target, path.join(home, "Applications"));
    }
    const slot = path.join(home, "Applications", APP);
    const staging = path.join(
      home,
      "Applications",
      `.styal-preview-install-${scenario.variant ?? "production"}`,
    );
    const injectedError = PlatformError.systemError({
      module: "FileSystem",
      method: "previewInstall",
      _tag: "PermissionDenied",
      description: "injected failure",
    });
    const faultFs = FileSystem.make({
      ...fs,
      lstat: (target) =>
        scenario.plistStatFails && target === path.join(slot, "Contents", "Info.plist")
          ? Effect.fail(injectedError)
          : fs.lstat(target),
      rename: (from, to) =>
        (scenario.fault === "backup" && from === slot) ||
        (scenario.fault === "promote" && from === path.join(staging, APP)) ||
        (scenario.fault === "retire" && from === path.join(staging, "previous.app"))
          ? Effect.fail(injectedError)
          : fs.rename(from, to),
      remove: (target, options) =>
        Effect.gen(function* () {
          const deletingBackup =
            target === path.join(staging, "previous.app") ||
            target === path.join(staging, "removed.app");
          const deletingStaging = target === staging;
          if (
            (scenario.fault === "remove" && deletingBackup && (yield* fs.exists(target))) ||
            (scenario.fault === "cleanup" && deletingStaging)
          ) {
            const damaged = deletingBackup
              ? target
              : path.join(
                  staging,
                  (yield* fs.exists(path.join(staging, "retired.app")))
                    ? "retired.app"
                    : "previous.app",
                );
            yield* fs.remove(path.join(damaged, "Contents", "Info.plist"), { force: true });
            return yield* injectedError;
          }
          yield* fs.remove(target, options);
        }),
    });
    const commands: Array<ReadonlyArray<string>> = [];
    const states: Array<unknown> = [];
    const urls: Array<string> = [];
    let signalled = false;
    let mounted: string | null = null;
    const killChecks: Array<string> = [];
    const dialogs: Array<Electron.MessageBoxOptions> = [];
    const dialogOwners: Array<unknown> = [];
    const mainWindow = { id: 1 };

    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const { command: name, args } = command as unknown as {
          readonly command: string;
          readonly args: ReadonlyArray<string>;
        };
        commands.push([name, ...args]);
        let stdout = "";
        let exitCode = 0;
        if (name === "/usr/bin/plutil") {
          if (scenario.plutilFails) return yield* injectedError;
          const [, key, , , , plist] = args;
          const content = yield* fs.readFileString(plist!).pipe(Effect.orElseSucceed(() => null));
          const bundle = yield* Effect.try({
            try: () => JSON.parse(content ?? "{}") as Record<string, unknown>,
            catch: () => injectedError,
          }).pipe(Effect.orElseSucceed(() => ({}) as Record<string, unknown>));
          const field =
            key === "CFBundleIdentifier"
              ? "identifier"
              : key === "CFBundleExecutable"
                ? "executable"
                : "version";
          const value = bundle?.[field];
          if (typeof value === "string") stdout = value;
          else exitCode = 1;
        } else if (name === "/usr/bin/hdiutil" && args[0] === "attach") {
          exitCode = scenario.attachExitCode ?? 0;
          if (exitCode === 0) mounted = args[args.length - 1]!;
          if (exitCode === 0 && scenario.dmgHasApp !== false) {
            yield* writeBundle(
              path.join(args[args.length - 1]!, APP),
              scenario.dmgBundle ?? { identifier: PREVIEW_ID, version: "1.2.3-pr.12.7" },
            );
          }
        } else if (name === "/usr/bin/hdiutil" && args[0] === "detach") {
          if (scenario.detachFails === true) {
            exitCode = 1;
          } else {
            yield* fs.remove(args[1]!, { recursive: true, force: true });
            mounted = null;
          }
        } else if (name === "/sbin/mount") {
          if (mounted !== null)
            stdout = `/dev/disk9s1 on ${yield* fs.realPath(mounted)} (hfs, local, read-only)\n`;
        } else if (name === "/usr/bin/ditto") {
          if (scenario.fault === "copy") {
            yield* fs.makeDirectory(path.join(args[1]!, "Contents", "Resources"), {
              recursive: true,
            });
            exitCode = 1;
          } else {
            yield* fs.copy(args[0]!, args[1]!);
          }
        } else if (name === "/usr/bin/xattr") {
          if (scenario.xattrFails === true) exitCode = 1;
          if (scenario.quarantined === true) stdout = `${args[2]}: com.apple.quarantine\n`;
          if (scenario.xattrOutput !== undefined) stdout = scenario.xattrOutput;
        } else if (name === "/bin/kill" && args[0] === "-0") {
          killChecks.push(args[1]!);
          exitCode = args[1] === "4242" ? 0 : 1;
        } else if (name === "/bin/kill") {
          signalled = true;
        } else if (name === "/bin/ps" && scenario.psFails === true) {
          exitCode = 1;
        } else if (name === "/bin/ps") {
          if (
            scenario.runningPreview === "stuck" ||
            (scenario.runningPreview === "quits" && !signalled)
          ) {
            stdout = `  100     1 ${slot}/Contents/MacOS/styal (Preview)\n`;
          }
        } else if (name === "/usr/bin/open") {
          exitCode = scenario.openExitCode ?? 0;
          if (scenario.rejectedRenameFails === true) {
            // A non-empty destination makes the rename fail on the real filesystem.
            yield* fs.makeDirectory(path.join(staging, "rejected.app", "occupied"), {
              recursive: true,
            });
          }
        }
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: output(stdout),
          stderr: output(exitCode === 0 ? "" : "tool failed"),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      ),
    );

    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        urls.push(request.url);
        const respond = (body: BodyInit, status = 200) =>
          HttpClientResponse.fromWeb(request, new Response(body, { status }));
        if (request.url.endsWith("/releases/tags/desktop-preview")) {
          if (scenario.releaseStalled !== undefined) {
            Deferred.doneUnsafe(scenario.releaseStalled, Effect.void);
            return respond(new ReadableStream({ start: () => undefined }));
          }
          if (scenario.releaseStatus !== undefined) return respond("", scenario.releaseStatus);
          return respond(JSON.stringify({ assets: scenario.assets ?? [] }));
        }
        if (/\/pulls\/\d+$/.test(request.url)) {
          if (scenario.installedDuringLookup !== undefined) {
            yield* writeBundle(slot, {
              identifier: PREVIEW_ID,
              version: scenario.installedDuringLookup,
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
            );
          }
          return respond(JSON.stringify({ state: scenario.pullRequestState ?? "open" }));
        }
        if (scenario.downloadStarted !== undefined) {
          Deferred.doneUnsafe(scenario.downloadStarted, Effect.void);
          return respond(new ReadableStream({ start: () => undefined }));
        }
        if (scenario.slotDuringDownload !== undefined) {
          yield* fs.remove(slot, { recursive: true, force: true });
          if (scenario.slotDuringDownload === "foreign") {
            yield* writeBundle(slot, { identifier: "com.example.other", version: "9.9.9" }).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
            );
          } else {
            yield* fs.makeDirectory(slot, { recursive: true });
            yield* fs.writeFileString(path.join(slot, "keep.txt"), "unrelated folder");
          }
        }
        return respond((scenario.downloadBytes ?? DMG_BYTES) as BodyInit);
      }).pipe(Effect.orDie),
    );

    const environment = DesktopEnvironment.DesktopEnvironment.of({
      path,
      platform: scenario.platform ?? "darwin",
      processArch: "arm64",
      installVariant: scenario.variant ?? "production",
      appVersion: "1.2.3",
      appPath: scenario.runningFromSlot
        ? `${slot}/Contents/Resources/app.asar`
        : (scenario.appPath ?? "/Applications/styal.app/Contents/Resources/app.asar"),
      homeDirectory: home,
      appDataDirectory: appData,
      baseDir,
    } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

    const service = yield* DesktopPreviewApp.make({ quitPolls: 0 }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
          Layer.succeed(FileSystem.FileSystem, faultFs),
          DesktopManagedPolicy.layerTest(scenario.policy),
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.succeed(
            ElectronDialog.ElectronDialog,
            ElectronDialog.ElectronDialog.of({
              showMessageBox: (options: Electron.MessageBoxOptions, owner?: unknown) =>
                Effect.sync(() => {
                  dialogs.push(options);
                  dialogOwners.push(owner);
                  return { response: scenario.confirmed === false ? 1 : 0, checkboxChecked: false };
                }),
            } as unknown as ElectronDialog.ElectronDialog["Service"]),
          ),
          Layer.succeed(
            ElectronWindow.ElectronWindow,
            ElectronWindow.ElectronWindow.of({
              sendAll: (_channel: string, state: unknown) =>
                Effect.sync(() => void states.push(state)),
              focusedMainOrFirst: Effect.succeed(
                scenario.noWindow === true ? Option.none() : Option.some(mainWindow),
              ),
            } as unknown as ElectronWindow.ElectronWindow["Service"]),
          ),
          Layer.succeed(
            DesktopTelemetryPublisher.DesktopTelemetryPublisher,
            DesktopTelemetryPublisher.DesktopTelemetryPublisher.of(
              {} as unknown as DesktopTelemetryPublisher.DesktopTelemetryPublisher["Service"],
            ),
          ),
        ),
      ),
    );

    const ran = (tool: string) => commands.filter((command) => command[0] === tool);
    const installPrevious = (version: string, identifier = PREVIEW_ID) =>
      writeBundle(slot, { identifier, version });
    const stagingIsGone = fs.exists(staging).pipe(Effect.map((present) => !present));
    const isMounted = () => mounted !== null;
    return {
      service,
      fs,
      path,
      home,
      baseDir,
      appData,
      slot,
      commands,
      states,
      urls,
      dialogs,
      dialogOwners,
      mainWindow,
      killChecks,
      staging,
      isMounted,
      ran,
      installPrevious,
      stagingIsGone,
    };
  });

const buildAsset = asset("styal-1.2.3-pr.12.7-arm64.dmg");

const installedVersion = (slot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    assert.strictEqual(yield* fs.readFileString(`${slot}/Contents/MacOS/styal`), "executable");
    assert.strictEqual(
      yield* fs.readFileString(`${slot}/Contents/Resources/app.asar`),
      "resources",
    );
    const content = yield* fs.readFileString(`${slot}/Contents/Info.plist`);
    return (JSON.parse(content) as { version: string }).version;
  });

const scoped = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("DesktopPreviewApp", () => {
  it.effect.each(["user", "closed"] as const)("refuses symlinked staging on %s removal", (source) =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({ pullRequestState: "closed" });
        yield* app.installPrevious("1.2.3-pr.12.6");
        const documents = app.path.join(app.home, "Documents");
        for (const name of ["previous.app", "removed.app"]) {
          yield* app.fs.makeDirectory(app.path.join(documents, name), { recursive: true });
          yield* app.fs.writeFileString(
            app.path.join(documents, name, "keep.txt"),
            "unrelated files",
          );
        }
        yield* app.fs.symlink(documents, app.staging);
        if (source === "user") assert.strictEqual((yield* app.service.remove).outcome, "failed");
        else yield* app.service.removeIfPullRequestClosed;
        assert.strictEqual(yield* installedVersion(app.slot), "1.2.3-pr.12.6");
        for (const name of ["previous.app", "removed.app"]) {
          assert.strictEqual(
            yield* app.fs.readFileString(app.path.join(documents, name, "keep.txt")),
            "unrelated files",
          );
        }
      }),
    ),
  );

  it.effect.each(["foreign", "folder"] as const)(
    "leaves a %s appearing during download untouched",
    (slotDuringDownload) =>
      scoped(
        Effect.gen(function* () {
          const app = yield* setup({ assets: [buildAsset], slotDuringDownload });
          yield* app.installPrevious("1.2.3-pr.12.6");
          const result = yield* app.service.install(12);
          assert.strictEqual(result.outcome, "failed");
          assert.include(result.message, "left in place");
          if (slotDuringDownload === "foreign")
            assert.strictEqual(yield* installedVersion(app.slot), "9.9.9");
          else
            assert.strictEqual(
              yield* app.fs.readFileString(app.path.join(app.slot, "keep.txt")),
              "unrelated folder",
            );
          assert.lengthOf(app.ran("/usr/bin/open"), 0);
        }),
      ),
  );

  it.effect.each(["user", "closed"] as const)(
    "does not restore stale deletion leftovers on %s removal",
    (source) =>
      scoped(
        Effect.gen(function* () {
          const app = yield* setup({
            assets: [buildAsset],
            fault: "cleanup",
            pullRequestState: "closed",
          });
          yield* app.installPrevious("1.2.3-pr.12.6");
          assert.strictEqual((yield* app.service.install(12)).outcome, "completed");
          const retired = app.path.join(app.staging, "retired.app");
          if (yield* app.fs.exists(retired))
            yield* app.fs.rename(retired, app.path.join(app.staging, "previous.app"));
          if (source === "user") yield* app.service.remove;
          else yield* app.service.removeIfPullRequestClosed;
          assert.isFalse(yield* app.fs.exists(app.slot));
          yield* app.service.cleanLeftovers;
          assert.isFalse(yield* app.fs.exists(app.slot));
        }),
      ),
  );

  it.effect("keeps the current app when retiring an older backup fails", () =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({ assets: [buildAsset], fault: "retire" });
        yield* app.installPrevious("1.2.3-pr.12.6");
        assert.strictEqual((yield* app.service.install(12)).outcome, "completed");
        assert.strictEqual((yield* app.service.remove).outcome, "failed");
        assert.strictEqual(yield* installedVersion(app.slot), "1.2.3-pr.12.7");
        assert.strictEqual(
          yield* installedVersion(app.path.join(app.staging, "previous.app")),
          "1.2.3-pr.12.6",
        );
      }),
    ),
  );

  it.effect("clears retained rejected apps before repeated failed launches", () =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({ assets: [buildAsset], openExitCode: 1 });
        yield* app.fs.makeDirectory(app.path.join(app.slot, "Contents", "Resources"), {
          recursive: true,
        });
        yield* app.fs.makeDirectory(app.path.join(app.staging, "rejected.app", "old"), {
          recursive: true,
        });
        for (const attempt of [1, 2, 3]) {
          const result = yield* app.service.install(12);
          assert.strictEqual(result.outcome, "failed");
          assert.notInclude(result.message ?? "", "still attached");
          assert.isNull(result.state.installed);
          assert.lengthOf(app.ran("/usr/bin/open"), attempt);
        }
      }),
    ),
  );

  it.effect.each([
    "spawn",
    "malformed",
    "missing-key",
    "folder",
    "symlink",
    "dangling-symlink",
    "permission",
    "other-variant",
  ] as const)("refuses unsafe recovery: %s", (kind) =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({
          assets: [buildAsset],
          plutilFails: kind === "spawn",
          plistStatFails: kind === "permission",
        });
        yield* app.fs.makeDirectory(app.staging, { recursive: true });
        if (kind === "folder") yield* app.fs.makeDirectory(app.slot);
        else if (kind === "symlink" || kind === "dangling-symlink") {
          const target = app.path.join(app.home, "other.app");
          if (kind === "symlink")
            yield* writeBundle(target, { identifier: "com.example.other", version: "9.9.9" });
          yield* app.fs.symlink(target, app.slot);
        } else {
          yield* app.installPrevious("9.9.9", "com.example.other");
          const plist = app.path.join(app.slot, "Contents", "Info.plist");
          if (kind === "malformed") yield* app.fs.writeFileString(plist, "bad plist");
          if (kind === "missing-key")
            yield* app.fs.writeFileString(plist, JSON.stringify({ version: "9.9.9" }));
          if (kind === "other-variant") {
            yield* app.fs.remove(plist);
            yield* app.fs.remove(app.staging, { recursive: true });
            yield* app.fs.makeDirectory(
              app.path.join(app.home, "Applications", ".styal-preview-install-development"),
            );
          }
        }
        assert.isFalse((yield* app.service.state).canRemove);
        assert.strictEqual((yield* app.service.install(12)).outcome, "failed");
        assert.strictEqual((yield* app.service.remove).outcome, "failed");
        assert.isDefined(yield* app.fs.lstat(app.slot));
        assert.lengthOf(app.ran("/usr/bin/ditto"), 0);
      }),
    ),
  );

  it.effect.each([false, true])(
    "preserves an unverified backup without restoring it, plutil unavailable: %s",
    (plutilFails) =>
      scoped(
        Effect.gen(function* () {
          const app = yield* setup({ plutilFails });
          const backup = app.path.join(app.staging, "previous.app");
          yield* writeBundle(backup, { identifier: PREVIEW_ID, version: "1.2.3-pr.12.6" });
          if (!plutilFails)
            yield* app.fs.remove(app.path.join(backup, "Contents", "MacOS"), { recursive: true });
          yield* app.service.cleanLeftovers;
          assert.isFalse(yield* app.fs.exists(app.slot));
          assert.isFalse((yield* app.service.state).canOpen);
          assert.isTrue(yield* app.fs.exists(backup));
          if (plutilFails) assert.strictEqual(yield* installedVersion(backup), "1.2.3-pr.12.6");
        }),
      ),
  );

  it.effect.each(["backup", "promote", "cleanup", "copy"] as const)(
    "keeps a complete old or new app when %s fails",
    (fault) =>
      scoped(
        Effect.gen(function* () {
          const app = yield* setup({ assets: [buildAsset], fault });
          yield* app.installPrevious("1.2.3-pr.12.6");
          const result = yield* app.service.install(12);
          assert.strictEqual(result.outcome, fault === "cleanup" ? "completed" : "failed");
          assert.strictEqual(
            yield* installedVersion(app.slot),
            fault === "cleanup" ? "1.2.3-pr.12.7" : "1.2.3-pr.12.6",
          );
        }),
      ),
  );

  it.effect("never restores a partly deleted app into the slot", () =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({ fault: "remove" });
        yield* app.installPrevious("1.2.3-pr.12.6");
        assert.strictEqual((yield* app.service.remove).outcome, "failed");
        assert.isFalse(yield* app.fs.exists(app.slot));
        yield* app.service.cleanLeftovers;
        assert.isFalse(yield* app.fs.exists(app.slot));
      }),
    ),
  );

  it.effect.each(["install", "remove"] as const)(
    "recovers a broken preview with its own marker via %s",
    (action) =>
      scoped(
        Effect.gen(function* () {
          const app = yield* setup({ assets: [buildAsset] });
          yield* app.fs.makeDirectory(app.path.join(app.slot, "Contents", "Resources"), {
            recursive: true,
          });
          const marker = app.staging;
          yield* app.fs.makeDirectory(marker, { recursive: true });
          yield* app.service.cleanLeftovers;
          const state = yield* app.service.state;
          assert.isNull(state.installed);
          assert.isFalse(state.canOpen);
          assert.isTrue(state.canRemove);
          const result = yield* action === "install" ? app.service.install(12) : app.service.remove;
          assert.strictEqual(result.outcome, "completed");
          if (action === "install")
            assert.strictEqual(yield* installedVersion(app.slot), "1.2.3-pr.12.7");
          else assert.isFalse(yield* app.fs.exists(app.slot));
        }),
      ),
  );

  it.effect("preserves its recovery marker across startup and failed installation", () =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({ assets: [buildAsset], fault: "copy" });
        yield* app.fs.makeDirectory(app.path.join(app.slot, "Contents", "Resources"), {
          recursive: true,
        });
        yield* app.fs.makeDirectory(app.staging, { recursive: true });
        yield* app.service.cleanLeftovers;
        assert.isTrue(yield* app.fs.exists(app.staging));
        assert.strictEqual((yield* app.service.install(12)).outcome, "failed");
        assert.isTrue(yield* app.fs.exists(app.staging));
        assert.isTrue((yield* app.service.state).canRemove);
      }),
    ),
  );

  it.effect("refuses an incomplete app without an install marker", () =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({ assets: [buildAsset] });
        yield* app.fs.makeDirectory(app.path.join(app.slot, "Contents", "Resources"), {
          recursive: true,
        });
        assert.isFalse((yield* app.service.state).canRemove);
        assert.strictEqual((yield* app.service.install(12)).outcome, "failed");
        assert.strictEqual((yield* app.service.remove).outcome, "failed");
        assert.isTrue(yield* app.fs.exists(app.slot));
      }),
    ),
  );

  it.effect("installs a build, quitting the running one, and leaves nothing behind", () =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({ assets: [buildAsset], runningPreview: "quits" });
        yield* app.installPrevious("1.2.3-pr.12.6");

        const result = yield* app.service.install(12);

        assert.strictEqual(result.outcome, "completed");
        assert.deepStrictEqual(result.state.installed, {
          version: "1.2.3-pr.12.7",
          pullRequestNumber: 12,
          runNumber: 7,
        });
        assert.lengthOf(app.dialogs, 0);
        assert.strictEqual(yield* installedVersion(app.slot), "1.2.3-pr.12.7");
        assert.isTrue(yield* app.stagingIsGone);

        const attach = app.ran("/usr/bin/hdiutil").find((command) => command[1] === "attach");
        assert.isTrue(attach?.includes("-nobrowse"));
        assert.lengthOf(
          app.ran("/usr/bin/hdiutil").filter((command) => command[1] === "detach"),
          1,
        );
        // The order that keeps the old build intact until the new one has passed its checks.
        const order = app.commands.map((command) => command[0]);
        assert.isBelow(order.indexOf("/usr/bin/xattr"), order.indexOf("/bin/kill"));
        assert.isBelow(order.indexOf("/bin/kill"), order.indexOf("/usr/bin/open"));
        assert.deepStrictEqual(app.ran("/usr/bin/open"), [["/usr/bin/open", app.slot]]);
        assert.deepStrictEqual(app.ran("/bin/kill"), [["/bin/kill", "-TERM", "100"]]);

        assert.isTrue(
          app.urls.some((url) =>
            url.startsWith(
              "https://github.com/incognitojam/styal/releases/download/desktop-preview/",
            ),
          ),
        );
      }),
    ),
  );

  it.effect.each([
    { name: "turns updates off", updates: { mode: "off" as const } },
    {
      name: "sets its own update feed",
      updates: { mode: "auto" as const, feedUrl: "https://updates.example.com/styal" },
    },
    { name: "disallows nightly", updates: { mode: "auto" as const, allowNightly: false } },
  ])("refuses to install when a managed policy $name", ({ updates }) =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({
          assets: [buildAsset],
          policy: {
            schemaVersion: 1,
            organization: "Example Corp",
            limits: { updates },
          },
        });

        const result = yield* app.service.install(12);

        assert.strictEqual(result.outcome, "failed");
        assert.strictEqual(result.message, "Example Corp manages styal updates.");
        assert.lengthOf(app.commands, 0);
      }),
    ),
  );

  it.effect.each([
    {
      name: "a digest mismatch",
      scenario: { downloadBytes: new TextEncoder().encode("tampered") },
      reason: "digest_mismatch",
    },
    {
      name: "a failed mount",
      scenario: { attachExitCode: 1 },
      reason: "mount",
    },
    {
      name: "a DMG without the app",
      scenario: { dmgHasApp: false },
      reason: "wrong_app",
    },
    {
      name: "a production bundle identity",
      scenario: { dmgBundle: { identifier: "build.styal.app", version: "1.2.3-pr.12.7" } },
      reason: "wrong_app",
    },
    {
      name: "a version other than the published one",
      scenario: { dmgBundle: { identifier: PREVIEW_ID, version: "1.2.3" } },
      reason: "wrong_app",
    },
    {
      name: "a quarantined build",
      scenario: { quarantined: true },
      reason: "quarantined",
    },
    {
      name: "a quarantine attribute on a file inside the build",
      scenario: {
        xattrOutput: `/staging/${APP}/Contents/MacOS/styal (Preview): com.apple.quarantine\n`,
      },
      reason: "quarantined",
    },
    {
      name: "attributes that cannot be read",
      scenario: { xattrFails: true },
      reason: "quarantine_check",
    },
    {
      name: "a process list that cannot be read",
      scenario: { psFails: true },
      reason: "quit_timeout",
    },
  ] as const)("keeps the installed build after $name", ({ scenario, reason }) =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({ assets: [buildAsset], ...scenario });
        yield* app.installPrevious("1.2.3-pr.12.6");

        const result = yield* app.service.install(12);

        assert.strictEqual(result.outcome, "failed");

        assert.strictEqual(yield* installedVersion(app.slot), "1.2.3-pr.12.6");
        assert.isTrue(yield* app.stagingIsGone);
        if (reason !== "digest_mismatch" && reason !== "mount") {
          assert.isNotEmpty(
            app.ran("/usr/bin/hdiutil").filter((command) => command[1] === "detach"),
          );
        }
        assert.lengthOf(app.ran("/usr/bin/open"), 0);
        assert.lengthOf(app.ran("/bin/kill"), 0);
        assert.isFalse(app.isMounted());
        // The attribute is reported, never cleared.
        assert.isFalse(app.ran("/usr/bin/xattr").some((command) => command.includes("-d")));
      }),
    ),
  );

  it.effect("puts the previous build back when macOS refuses to open the new one", () =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({ assets: [buildAsset], openExitCode: 1 });
        yield* app.installPrevious("1.2.3-pr.12.6");

        const result = yield* app.service.install(12);

        assert.strictEqual(result.outcome, "failed");
        assert.lengthOf(app.ran("/usr/bin/open"), 1);
        assert.strictEqual(yield* installedVersion(app.slot), "1.2.3-pr.12.6");
        assert.isTrue(yield* app.stagingIsGone);
      }),
    ),
  );

  it.effect("restores the old app after clearing a rejected-build collision", () =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({
          assets: [buildAsset],
          openExitCode: 1,
          rejectedRenameFails: true,
        });
        yield* app.installPrevious("1.2.3-pr.12.6");

        const result = yield* app.service.install(12);

        assert.strictEqual(result.outcome, "failed");
        assert.strictEqual(yield* installedVersion(app.slot), "1.2.3-pr.12.6");
        assert.isTrue(yield* app.stagingIsGone);
        const again = yield* app.service.install(12);
        assert.strictEqual(again.outcome, "failed");
        assert.notInclude(again.message ?? "", "still attached");
        assert.strictEqual(yield* installedVersion(app.slot), "1.2.3-pr.12.6");
      }),
    ),
  );

  it.effect("restores the backup even when the volume stays attached", () =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({ assets: [buildAsset], openExitCode: 1, detachFails: true });
        yield* app.installPrevious("1.2.3-pr.12.6");

        const result = yield* app.service.install(12);

        assert.strictEqual(result.outcome, "failed");
        assert.isTrue(app.isMounted());
        assert.strictEqual(yield* installedVersion(app.slot), "1.2.3-pr.12.6");
      }),
    ),
  );

  it.effect("gives up on a lookup that never finishes, so later actions can run", () =>
    scoped(
      Effect.gen(function* () {
        const releaseStalled = yield* Deferred.make<void>();
        const app = yield* setup({ releaseStalled });

        const install = yield* app.service.install(12).pipe(Effect.forkScoped);
        yield* Deferred.await(releaseStalled);
        yield* TestClock.adjust("31 seconds");
        const result = yield* Fiber.join(install);

        assert.strictEqual(result.outcome, "failed");
        assert.strictEqual(result.state.activity.status, "idle");
      }),
    ),
  );

  it.effect("leaves nothing installed when the first install cannot open", () =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({ assets: [buildAsset], openExitCode: 1 });
        const result = yield* app.service.install(12);
        assert.strictEqual(result.outcome, "failed");
        assert.isNull(result.state.installed);
        assert.isFalse(yield* app.fs.exists(app.slot));
      }),
    ),
  );

  it.effect.each(["backed-up", "promoted", "cleaning"] as const)(
    "recovers a crash with the app %s",
    (step) =>
      scoped(
        Effect.gen(function* () {
          const app = yield* setup({});
          yield* writeBundle(app.path.join(app.staging, "previous.app"), {
            identifier: PREVIEW_ID,
            version: "1.2.3-pr.12.6",
          });

          if (step !== "backed-up") yield* app.installPrevious("1.2.3-pr.12.7");
          if (step === "cleaning") {
            yield* app.fs.remove(
              app.path.join(app.staging, "previous.app", "Contents", "Info.plist"),
            );
          }
          yield* app.service.cleanLeftovers;

          assert.strictEqual(
            yield* installedVersion(app.slot),
            step === "backed-up" ? "1.2.3-pr.12.6" : "1.2.3-pr.12.7",
          );
          assert.isTrue(yield* app.stagingIsGone);
        }),
      ),
  );

  it.effect.each([false, true])(
    "never removes mounted staging with symlinked Applications: %s",
    (symlinkApplications) =>
      scoped(
        Effect.gen(function* () {
          const app = yield* setup({
            assets: [buildAsset],
            detachFails: true,
            symlinkApplications,
          });
          yield* app.installPrevious("1.2.3-pr.12.6");

          const first = yield* app.service.install(12);

          // The copy succeeded, so the install finishes even though the volume could not detach.
          assert.strictEqual(first.outcome, "completed");
          assert.isTrue(app.isMounted());
          assert.isTrue(yield* app.fs.exists(app.path.join(app.staging, "mount", APP)));
          assert.isTrue(
            app
              .ran("/usr/bin/hdiutil")
              .some((command) => command[1] === "detach" && command.includes("-force")),
          );

          const second = yield* app.service.install(12);
          assert.strictEqual(second.outcome, "failed");
          assert.include(second.message, "still attached");
        }),
      ),
  );

  it.effect("names the quarantine in the failure rather than working around it", () =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({ assets: [buildAsset], quarantined: true });
        const result = yield* app.service.install(12);
        assert.include(result.message, "com.apple.quarantine");
      }),
    ),
  );

  it.effect("keeps the old build when the running preview refuses to quit", () =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({ assets: [buildAsset], runningPreview: "stuck" });
        yield* app.installPrevious("1.2.3-pr.12.6");

        const result = yield* app.service.install(12);

        assert.strictEqual(result.outcome, "failed");
        assert.include(result.message, "did not quit");
        assert.strictEqual(yield* installedVersion(app.slot), "1.2.3-pr.12.6");
        assert.deepStrictEqual(app.ran("/bin/kill"), [["/bin/kill", "-TERM", "100"]]);
      }),
    ),
  );

  it.effect("leaves an app it does not recognise in the install location", () =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({ assets: [buildAsset] });
        yield* app.installPrevious("9.9.9", "com.example.other");
        yield* app.fs.makeDirectory(app.staging, { recursive: true });

        const installed = yield* app.service.install(12);
        const removed = yield* app.service.remove;

        assert.strictEqual(installed.outcome, "failed");
        assert.include(installed.message, "left in place");
        assert.strictEqual(removed.outcome, "failed");
        assert.strictEqual(yield* installedVersion(app.slot), "9.9.9");
      }),
    ),
  );

  it.effect("reports a pull request without a build without touching the disk", () =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({ assets: [asset("styal-1.2.3-pr.123.1-arm64.dmg")] });
        const result = yield* app.service.install(12);
        assert.strictEqual(result.outcome, "failed");
        assert.isNull((yield* app.service.findBuild(12)).build);
        assert.lengthOf(app.ran("/usr/bin/hdiutil"), 0);
      }),
    ),
  );

  it.effect("stops after installing when it is itself a preview app", () =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({
          variant: "preview",
          assets: [buildAsset],
          appPath: `/Volumes/styal/${APP}/Contents/Resources/app.asar`,
          runningPreview: "stuck",
        });

        const result = yield* app.service.install(12);

        assert.strictEqual(result.outcome, "completed");
        assert.isFalse(result.state.opensAfterInstall);
        assert.isFalse(result.state.canOpen);
        assert.isFalse(result.state.canReset);
        assert.strictEqual(yield* installedVersion(app.slot), "1.2.3-pr.12.7");
        assert.lengthOf(app.ran("/bin/kill"), 0);
        assert.lengthOf(app.ran("/usr/bin/open"), 0);
      }),
    ),
  );

  it.effect("refuses to replace or remove the app it is running from", () =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({
          variant: "preview",
          assets: [buildAsset],
          runningFromSlot: true,
        });
        yield* app.installPrevious("1.2.3-pr.12.6");

        assert.isFalse((yield* app.service.state).canInstall);
        const installed = yield* app.service.install(12);
        const removed = yield* app.service.remove;

        assert.strictEqual(installed.outcome, "failed");
        assert.strictEqual(removed.outcome, "failed");
        assert.strictEqual(yield* installedVersion(app.slot), "1.2.3-pr.12.6");
      }),
    ),
  );

  it.effect("removes the app but keeps preview data, and resets data but keeps the app", () =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({ assets: [buildAsset] });
        const previewHome = app.path.join(app.baseDir, "preview", "userdata");
        const electronData = app.path.join(app.appData, "styal-preview");
        const productionState = app.path.join(app.baseDir, "userdata");
        const productionElectron = app.path.join(app.appData, "styal");
        yield* Effect.forEach(
          [previewHome, electronData, productionState, productionElectron],
          (directory) => app.fs.makeDirectory(directory, { recursive: true }),
        );
        yield* app.installPrevious("1.2.3-pr.12.6");

        const reset = yield* app.service.resetData;
        assert.strictEqual(reset.outcome, "completed");
        assert.isFalse(yield* app.fs.exists(app.path.join(app.baseDir, "preview")));
        assert.isFalse(yield* app.fs.exists(electronData));
        assert.isTrue(yield* app.fs.exists(productionState));
        assert.isTrue(yield* app.fs.exists(productionElectron));
        assert.isTrue(yield* app.fs.exists(app.slot));
        assert.isFalse(reset.state.canReset);

        yield* app.fs.makeDirectory(previewHome, { recursive: true });
        const removed = yield* app.service.remove;
        assert.strictEqual(removed.outcome, "completed");
        assert.isNull(removed.state.installed);
        assert.isFalse(yield* app.fs.exists(app.slot));
        assert.isTrue(yield* app.fs.exists(previewHome));
        assert.isTrue(yield* app.stagingIsGone);
      }),
    ),
  );

  it.effect("keeps preview data when another server is using it or the person declines", () =>
    scoped(
      Effect.gen(function* () {
        const declined = yield* setup({ confirmed: false });
        const declinedData = declined.path.join(declined.baseDir, "preview");
        yield* declined.fs.makeDirectory(declinedData, { recursive: true });
        assert.strictEqual((yield* declined.service.resetData).outcome, "cancelled");
        assert.isTrue(yield* declined.fs.exists(declinedData));
        assert.lengthOf(declined.ran("/bin/ps"), 0);
        assert.strictEqual(declined.dialogs[0]?.defaultId, 1);
        assert.deepStrictEqual(declined.dialogOwners, [declined.mainWindow]);

        const noWindow = yield* setup({ noWindow: true });
        const noWindowData = noWindow.path.join(noWindow.baseDir, "preview");
        yield* noWindow.fs.makeDirectory(noWindowData, { recursive: true });
        assert.strictEqual((yield* noWindow.service.resetData).outcome, "cancelled");
        assert.lengthOf(noWindow.dialogs, 0);
        assert.isTrue(yield* noWindow.fs.exists(noWindowData));

        const app = yield* setup({});
        const state = app.path.join(app.baseDir, "preview", "userdata");
        yield* app.fs.makeDirectory(state, { recursive: true });
        yield* app.fs.writeFileString(
          app.path.join(state, "server-runtime.json"),
          JSON.stringify({ pid: 4242 }),
        );
        const result = yield* app.service.resetData;
        assert.strictEqual(result.outcome, "failed");
        assert.include(result.message, "process 4242");
        assert.isTrue(yield* app.fs.exists(state));
      }),
    ),
  );

  it.effect("deletes data whose recorded server has already exited", () =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({});
        const state = app.path.join(app.baseDir, "preview", "userdata");
        yield* app.fs.makeDirectory(state, { recursive: true });
        yield* app.fs.writeFileString(
          app.path.join(state, "server-runtime.json"),
          JSON.stringify({ pid: 7 }),
        );
        assert.strictEqual((yield* app.service.resetData).outcome, "completed");
        assert.deepStrictEqual(app.killChecks, ["7"]);
        assert.isFalse(yield* app.fs.exists(state));
      }),
    ),
  );

  it.effect("does not reset data from inside a preview app", () =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({ variant: "preview" });
        const data = app.path.join(app.baseDir, "preview");
        yield* app.fs.makeDirectory(data, { recursive: true });
        const result = yield* app.service.resetData;
        assert.strictEqual(result.outcome, "failed");
        assert.isTrue(yield* app.fs.exists(data));
      }),
    ),
  );

  it.effect.each([
    { pullRequestState: "open", running: false, kept: true },
    { pullRequestState: "closed", running: true, kept: true },
    { pullRequestState: "closed", running: false, kept: false },
  ] as const)(
    "a $pullRequestState pull request, preview running: $running, keeps the app: $kept",
    ({ pullRequestState, running, kept }) =>
      scoped(
        Effect.gen(function* () {
          const app = yield* setup({
            pullRequestState,
            ...(running ? { runningPreview: "stuck" as const } : {}),
          });
          yield* app.installPrevious("1.2.3-pr.12.7");
          yield* app.service.removeIfPullRequestClosed;
          assert.strictEqual(yield* app.fs.exists(app.slot), kept);
          if (!kept) {
          }
        }),
      ),
  );

  it.effect("does not remove a build installed while the closed lookup was in flight", () =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({
          pullRequestState: "closed",
          installedDuringLookup: "1.2.3-pr.99.1",
        });
        yield* app.installPrevious("1.2.3-pr.12.7");

        yield* app.service.removeIfPullRequestClosed;

        assert.strictEqual(yield* installedVersion(app.slot), "1.2.3-pr.99.1");
      }),
    ),
  );

  it.effect("reuses a recent lookup and says when GitHub did not answer", () =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({ assets: [buildAsset] });
        assert.strictEqual((yield* app.service.findBuild(12)).build?.runNumber, 7);
        yield* app.service.findBuild(12);
        yield* app.service.findBuild(13);
        assert.lengthOf(app.urls, 1);
        yield* TestClock.adjust("61 seconds");
        yield* app.service.findBuild(12);
        assert.lengthOf(app.urls, 2);

        const limited = yield* setup({ releaseStatus: 403 });
        assert.deepStrictEqual(yield* limited.service.findBuild(12), {
          build: null,
          lookupFailed: true,
        });
      }),
    ),
  );

  it.effect("keeps each variant's staging apart so one cannot clean up after another", () =>
    scoped(
      Effect.gen(function* () {
        const preview = yield* setup({ variant: "preview" });
        const fs = preview.fs;
        const other = preview.path.join(
          preview.home,
          "Applications",
          ".styal-preview-install-production",
        );
        yield* fs.makeDirectory(other, { recursive: true });
        yield* preview.service.cleanLeftovers;
        assert.isTrue(yield* fs.exists(other));
      }),
    ),
  );

  it.effect("does nothing and asks GitHub nothing off macOS or with nothing installed", () =>
    scoped(
      Effect.gen(function* () {
        const linux = yield* setup({ platform: "linux", assets: [buildAsset] });
        assert.isFalse((yield* linux.service.state).supported);
        assert.isNull((yield* linux.service.findBuild(12)).build);
        const result = yield* linux.service.install(12);
        assert.strictEqual(result.outcome, "failed");
        assert.lengthOf(linux.urls, 0);

        const idle = yield* setup({});
        yield* idle.service.removeIfPullRequestClosed;
        assert.lengthOf(idle.urls, 0);
      }),
    ),
  );

  it.effect("cancelling a download keeps the installed build and removes the partial file", () =>
    scoped(
      Effect.gen(function* () {
        const downloadStarted = yield* Deferred.make<void>();
        const app = yield* setup({ assets: [buildAsset], downloadStarted });
        yield* app.installPrevious("1.2.3-pr.12.6");

        const install = yield* app.service.install(12).pipe(Effect.forkScoped);
        yield* Deferred.await(downloadStarted);
        yield* app.service.cancelInstall;
        const result = yield* Fiber.join(install);

        assert.strictEqual(result.outcome, "cancelled");
        assert.strictEqual(result.state.activity.status, "idle");
        assert.strictEqual(yield* installedVersion(app.slot), "1.2.3-pr.12.6");
        assert.isTrue(yield* app.stagingIsGone);
        assert.lengthOf(app.ran("/usr/bin/open"), 0);
      }),
    ),
  );

  it.effect("refuses a second action while the first is running", () =>
    scoped(
      Effect.gen(function* () {
        const app = yield* setup({ assets: [buildAsset] });
        const [first, second] = yield* Effect.all(
          [app.service.install(12), app.service.install(12)],
          { concurrency: "unbounded" },
        );
        const outcomes = [first.outcome, second.outcome].toSorted();
        assert.deepStrictEqual(outcomes, ["completed", "failed"]);
      }),
    ),
  );
});
