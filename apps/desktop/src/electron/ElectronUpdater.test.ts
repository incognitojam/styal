import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
  AppImageUpdater: vi.fn(),
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
  });
  it.effect("explicit restart restores the native relaunch policy", () =>
    Effect.gen(function* () {
      autoUpdaterMock.autoRunAppAfterInstall = false;
      const updater = yield* ElectronUpdater.ElectronUpdater;
      yield* updater.quitAndInstall({ isSilent: true, isForceRunAfter: true });
      assert.isTrue(autoUpdaterMock.autoRunAppAfterInstall);
      assert.deepEqual(autoUpdaterMock.quitAndInstall.mock.calls, [[true, true]]);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );
});
