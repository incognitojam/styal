import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const {
  appendSwitchMock,
  autoUpdaterOnMock,
  autoUpdaterRemoveListenerMock,
  exitMock,
  getAppPathMock,
  getSystemLocaleMock,
  getUserDefaultMock,
  getVersionMock,
  onMock,
  onceMock,
  quitMock,
  relaunchMock,
  removeListenerMock,
  removeSwitchMock,
  setAboutPanelOptionsMock,
  setAppUserModelIdMock,
  setAsDefaultProtocolClientMock,
  setDesktopNameMock,
  setDockIconMock,
  setNameMock,
  setPathMock,
  whenReadyMock,
} = vi.hoisted(() => ({
  appendSwitchMock: vi.fn(),
  autoUpdaterOnMock: vi.fn(),
  autoUpdaterRemoveListenerMock: vi.fn(),
  exitMock: vi.fn(),
  getAppPathMock: vi.fn(() => "/app"),
  getSystemLocaleMock: vi.fn(() => "en-GB"),
  getUserDefaultMock: vi.fn((_key: string) => false),
  getVersionMock: vi.fn(() => "1.2.3"),
  onMock: vi.fn(),
  onceMock: vi.fn(),
  quitMock: vi.fn(),
  relaunchMock: vi.fn(),
  removeListenerMock: vi.fn(),
  removeSwitchMock: vi.fn(),
  setAboutPanelOptionsMock: vi.fn(),
  setAppUserModelIdMock: vi.fn(),
  setAsDefaultProtocolClientMock: vi.fn(() => true),
  setDesktopNameMock: vi.fn(),
  setDockIconMock: vi.fn(),
  setNameMock: vi.fn(),
  setPathMock: vi.fn(),
  whenReadyMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("electron", () => ({
  systemPreferences: { getUserDefault: getUserDefaultMock },
  autoUpdater: {
    on: autoUpdaterOnMock,
    removeListener: autoUpdaterRemoveListenerMock,
  },
  app: {
    commandLine: {
      appendSwitch: appendSwitchMock,
      removeSwitch: removeSwitchMock,
    },
    dock: {
      setIcon: setDockIconMock,
    },
    getAppPath: getAppPathMock,
    getSystemLocale: getSystemLocaleMock,
    getVersion: getVersionMock,
    isPackaged: true,
    name: "T3 Code",
    on: onMock,
    once: onceMock,
    quit: quitMock,
    relaunch: relaunchMock,
    removeListener: removeListenerMock,
    runningUnderARM64Translation: false,
    setAboutPanelOptions: setAboutPanelOptionsMock,
    setAsDefaultProtocolClient: setAsDefaultProtocolClientMock,
    setAppUserModelId: setAppUserModelIdMock,
    setDesktopName: setDesktopNameMock,
    setName: setNameMock,
    setPath: setPathMock,
    whenReady: whenReadyMock,
    exit: exitMock,
  },
}));

import * as ElectronApp from "./ElectronApp.ts";

describe("ElectronApp", () => {
  beforeEach(() => {
    appendSwitchMock.mockClear();
    autoUpdaterOnMock.mockClear();
    autoUpdaterRemoveListenerMock.mockClear();
    exitMock.mockClear();
    onMock.mockClear();
    onceMock.mockClear();
    quitMock.mockClear();
    relaunchMock.mockClear();
    removeListenerMock.mockClear();
    removeSwitchMock.mockClear();
    setPathMock.mockClear();
  });

  it.effect("registers one-shot app event listeners", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const listener = vi.fn();

      yield* electronApp.once("will-quit", listener);

      assert.deepEqual(onceMock.mock.calls, [["will-quit", listener]]);
    }).pipe(Effect.provide(ElectronApp.layer)),
  );
});
describe("ElectronApp", () => {
  beforeEach(() => {
    getSystemLocaleMock.mockReset();
    getUserDefaultMock.mockReset();
  });

  it("keeps the macOS region override and hour cycle in the locale tag", () => {
    assert.strictEqual(ElectronApp.toSystemLocaleTag("en_GB"), "en-GB");
    assert.strictEqual(ElectronApp.toSystemLocaleTag("en-US@rg=nlzzzz", "h12"), "en-NL-u-hc-h12");
    assert.strictEqual(ElectronApp.toSystemLocaleTag("en_US@rg=nlzzzz"), "en-NL");
    assert.strictEqual(ElectronApp.toSystemLocaleTag("en-GB", "h23"), "en-GB-u-hc-h23");
  });

  it("drops ICU keywords Intl cannot read instead of losing the whole locale", () => {
    assert.strictEqual(ElectronApp.toSystemLocaleTag("de_DE@calendar=buddhist"), "de-DE");
  });

  it.effect("follows LC_TIME on Linux when it differs from the language", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const systemLocale = yield* electronApp.systemLocale.pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, {
          LANG: "en_US.UTF-8",
          LC_TIME: "de_DE.UTF-8",
        }),
      );

      assert.strictEqual(systemLocale, "de-DE");
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("falls back to Chromium's locale on Linux when the time locale is C", () =>
    Effect.gen(function* () {
      getSystemLocaleMock.mockImplementationOnce(() => "fr-FR");
      const electronApp = yield* ElectronApp.ElectronApp;
      const systemLocale = yield* electronApp.systemLocale.pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, { LANG: "C.UTF-8" }),
      );

      assert.strictEqual(systemLocale, "fr-FR");
    }).pipe(Effect.provide(ElectronApp.layer)),
  );
});

it.effect("reads both macOS hour preferences without overriding explicit formats", () =>
  Effect.gen(function* () {
    for (const [preference, expected] of [
      ["AppleICUForce12HourTime", "en-NL-u-hc-h12"],
      ["AppleICUForce24HourTime", "en-NL-u-hc-h23"],
      ["", "en-NL"],
    ]) {
      getSystemLocaleMock.mockReturnValue("en_US@rg=nlzzzz");
      getUserDefaultMock.mockImplementation((key) => key === preference);
      const locale = yield* ElectronApp.make.systemLocale.pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
      );
      assert.strictEqual(locale, expected);
      for (const hour12 of [true, false]) {
        assert.strictEqual(
          new Intl.DateTimeFormat(locale, { hour: "numeric", hour12 }).resolvedOptions().hour12,
          hour12,
        );
      }
    }
  }),
);
