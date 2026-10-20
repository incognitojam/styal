import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { VerifyUpdateCodeSignature } from "electron-updater";
import { beforeEach, vi } from "vite-plus/test";

const { autoUpdaterMock, appMock } = vi.hoisted(() => ({
  appMock: { once: vi.fn(), removeListener: vi.fn() },
  autoUpdaterMock: {
    allowDowngrade: false,
    allowPrerelease: false,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    autoRunAppAfterInstall: true,
    channel: "latest",
    disableDifferentialDownload: false,
    fullChangelog: false,
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    downloadUpdate: vi.fn(() => Promise.resolve([])),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    verifyUpdateCodeSignature: undefined as VerifyUpdateCodeSignature | undefined,
    on: vi.fn(),
    once: vi.fn(),
    quitAndInstall: vi.fn(),
    removeListener: vi.fn(),
    setFeedURL: vi.fn(),
  },
}));

vi.mock("electron", () => ({ app: appMock }));

vi.mock("electron-updater", () => ({
  autoUpdater: autoUpdaterMock,
}));

import * as ElectronUpdater from "./ElectronUpdater.ts";

describe("ElectronUpdater", () => {
  beforeEach(() => {
    appMock.once.mockClear();
    appMock.removeListener.mockClear();
    autoUpdaterMock.once.mockClear();
    autoUpdaterMock.autoRunAppAfterInstall = true;
    autoUpdaterMock.allowDowngrade = false;
    autoUpdaterMock.allowPrerelease = false;
    autoUpdaterMock.autoDownload = true;
    autoUpdaterMock.autoInstallOnAppQuit = true;
    autoUpdaterMock.channel = "latest";
    autoUpdaterMock.disableDifferentialDownload = false;
    autoUpdaterMock.fullChangelog = false;
    autoUpdaterMock.checkForUpdates.mockClear();
    autoUpdaterMock.checkForUpdates.mockImplementation(() => Promise.resolve(null));
    autoUpdaterMock.downloadUpdate.mockClear();
    autoUpdaterMock.downloadUpdate.mockImplementation(() => Promise.resolve([]));
    autoUpdaterMock.on.mockClear();
    autoUpdaterMock.quitAndInstall.mockClear();
    autoUpdaterMock.removeListener.mockClear();
    autoUpdaterMock.setFeedURL.mockClear();
    autoUpdaterMock.verifyUpdateCodeSignature = undefined;
  });

  it.effect("scopes updater event listeners", () =>
    Effect.gen(function* () {
      const listener = vi.fn();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updater = yield* ElectronUpdater.ElectronUpdater;
          yield* updater.on("update-available", listener);
        }),
      );

      assert.deepEqual(autoUpdaterMock.on.mock.calls, [["update-available", listener]]);
      assert.deepEqual(autoUpdaterMock.removeListener.mock.calls, [["update-available", listener]]);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("wraps rejected update checks in the method-specific typed error", () =>
    Effect.gen(function* () {
      const cause = new Error("network unavailable");
      autoUpdaterMock.checkForUpdates.mockImplementationOnce(() => Promise.reject(cause));
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "beta";

      const error = yield* updater.checkForUpdates.pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterCheckForUpdatesError);
      assert.equal(error.channel, "beta");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, "Electron updater failed to check for updates on channel beta.");
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("preserves the execution-time channel on download failures", () =>
    Effect.gen(function* () {
      const cause = new Error("download unavailable");
      autoUpdaterMock.downloadUpdate.mockImplementationOnce(() => Promise.reject(cause));
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "nightly";

      const error = yield* updater.downloadUpdate.pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterDownloadUpdateError);
      assert.equal(error.channel, "nightly");
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Electron updater failed to download the update on channel nightly.",
      );
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("sets full changelog mode", () =>
    Effect.gen(function* () {
      const updater = yield* ElectronUpdater.ElectronUpdater;

      yield* updater.setFullChangelog(true);
      assert.equal(autoUpdaterMock.fullChangelog, true);

      yield* updater.setFullChangelog(false);
      assert.equal(autoUpdaterMock.fullChangelog, false);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("preserves quit-and-install flags and the execution-time channel", () =>
    Effect.gen(function* () {
      const cause = new Error("quit and install failed");
      autoUpdaterMock.quitAndInstall.mockImplementationOnce(() => {
        throw cause;
      });
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "latest";

      const error = yield* updater
        .quitAndInstall({ isSilent: true, isForceRunAfter: false })
        .pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterQuitAndInstallError);
      assert.equal(error.channel, "latest");
      assert.equal(error.isSilent, true);
      assert.equal(error.isForceRunAfter, false);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Electron updater failed to quit and install the update on channel latest (silent: true, force run after: false).",
      );
      assert.notInclude(error.message, cause.message);
      assert.deepEqual(autoUpdaterMock.quitAndInstall.mock.calls, [[true, false]]);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );
  it.effect("waits for normal quit without requesting a native macOS relaunch", () =>
    Effect.gen(function* () {
      const updater = yield* ElectronUpdater.ElectronUpdater;
      const install = yield* updater
        .quitAndInstall({ isSilent: true, isForceRunAfter: false })
        .pipe(Effect.forkChild({ startImmediately: true }));
      assert.isFalse(autoUpdaterMock.autoRunAppAfterInstall);
      assert.deepEqual(autoUpdaterMock.quitAndInstall.mock.calls, [[true, false]]);
      const onQuit = appMock.once.mock.calls.find(([event]) => event === "quit")?.[1];
      assert.isFunction(onQuit);
      onQuit();
      yield* Fiber.join(install);
      assert.equal(appMock.removeListener.mock.calls.length, 1);
      assert.equal(autoUpdaterMock.removeListener.mock.calls.length, 1);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("reports asynchronous native staging failure to the quit lifecycle", () =>
    Effect.gen(function* () {
      const updater = yield* ElectronUpdater.ElectronUpdater;
      const install = yield* updater
        .quitAndInstall({ isSilent: true, isForceRunAfter: false })
        .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      const cause = new Error("native staging failed");
      const onError = autoUpdaterMock.once.mock.calls.find(([event]) => event === "error")?.[1];
      assert.isFunction(onError);
      onError(cause);
      const error = yield* Fiber.join(install);
      assert.strictEqual(error.cause, cause);
      assert.equal(appMock.removeListener.mock.calls.length, 1);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("explicit restart restores the native relaunch policy", () =>
    Effect.gen(function* () {
      autoUpdaterMock.autoRunAppAfterInstall = false;
      const updater = yield* ElectronUpdater.ElectronUpdater;
      yield* updater.quitAndInstall({ isSilent: true, isForceRunAfter: true });
      assert.isTrue(autoUpdaterMock.autoRunAppAfterInstall);
      assert.deepEqual(autoUpdaterMock.quitAndInstall.mock.calls, [[true, true]]);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  describe("Windows update signature check", () => {
    const publisherNames = ["T3 Tools Inc"];
    const installerPath = "C:\\updater\\pending\\temp-T3-Code-x64.exe";
    // execFile marks the error killed when the verifier exceeds its 20-second timeout.
    const timedOut = () =>
      Object.assign(new Error("Command failed: powershell.exe"), { killed: true });

    const downloadVerifyingSignature = () => {
      autoUpdaterMock.downloadUpdate.mockImplementationOnce(async () => {
        const rejection = await autoUpdaterMock.verifyUpdateCodeSignature!(
          publisherNames,
          installerPath,
        );
        // NSIS accepts only null as a successful signature check.
        if (rejection !== null) throw new Error(`Invalid signature: ${rejection}`);
        return [];
      });
      return Effect.flatMap(ElectronUpdater.ElectronUpdater, (updater) => updater.downloadUpdate);
    };

    it.effect("retries a timed-out signature check with the same verifier and installer", () =>
      Effect.gen(function* () {
        const verify = vi
          .fn<VerifyUpdateCodeSignature>()
          .mockRejectedValueOnce(timedOut())
          .mockResolvedValueOnce(null);
        autoUpdaterMock.verifyUpdateCodeSignature = verify;

        yield* downloadVerifyingSignature();

        assert.deepEqual(verify.mock.calls, [
          [publisherNames, installerPath],
          [publisherNames, installerPath],
        ]);
      }).pipe(Effect.provide(ElectronUpdater.layer)),
    );

    it.effect("fails on invalid signatures, other errors and two timeouts on each download", () =>
      Effect.gen(function* () {
        const cases = [
          { outcome: () => Promise.resolve("Invalid publisher"), calls: 1 },
          { outcome: () => Promise.reject(new Error("Cannot execute PowerShell")), calls: 1 },
          { outcome: () => Promise.reject(timedOut()), calls: 2 },
        ];
        for (const { outcome, calls } of cases) {
          const verify = vi.fn<VerifyUpdateCodeSignature>(outcome);
          autoUpdaterMock.verifyUpdateCodeSignature = verify;

          // Reusing the installed verifier must neither stack retries nor exhaust future retries.
          for (let download = 1; download <= 2; download++) {
            const error = yield* downloadVerifyingSignature().pipe(Effect.flip);
            assert.instanceOf(error, ElectronUpdater.ElectronUpdaterDownloadUpdateError);
            assert.equal(verify.mock.calls.length, calls * download);
          }
        }
      }).pipe(Effect.provide(ElectronUpdater.layer)),
    );

    it.effect("rejects a retry when the upstream capability probe skips verification", () =>
      Effect.gen(function* () {
        const verify = vi
          .fn<VerifyUpdateCodeSignature>()
          .mockRejectedValueOnce(timedOut())
          .mockImplementationOnce(async () => {
            // Upstream resolves null even though its failed capability probe skips verification.
            autoUpdaterMock.logger.warn(
              "Cannot execute ConvertTo-Json: spawnSync powershell.exe ETIMEDOUT. Ignoring signature validation due to unsupported powershell version. Please upgrade to powershell 3 or higher.",
            );
            return null;
          });
        autoUpdaterMock.verifyUpdateCodeSignature = verify;

        const error = yield* downloadVerifyingSignature().pipe(Effect.flip);

        assert.instanceOf(error, ElectronUpdater.ElectronUpdaterDownloadUpdateError);
        assert.equal(verify.mock.calls.length, 2);
      }).pipe(Effect.provide(ElectronUpdater.layer)),
    );
  });
});
