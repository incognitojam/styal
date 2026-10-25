import { createHashHistory } from "@tanstack/react-router";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const downloadedState: DesktopUpdateState = {
  enabled: true,
  status: "downloaded",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: "1.1.0",
  downloadedVersion: "1.1.0",
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: 100,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: true,
};

// Installer handoff can quit the renderer before the install completes.
const acceptedInstall: DesktopUpdateActionResult = {
  accepted: true,
  completed: false,
  state: downloadedState,
};

function createWindow() {
  const values = new Map<string, string>();
  const location = new URL("styal://app/index.html");
  const replaceState = vi.fn((_state: unknown, _title: string, url?: string) => {
    if (url !== undefined) location.href = new URL(url, location).href;
  });
  return {
    location,
    desktopBridge: {} as object | undefined,
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
    history: {
      state: { key: "synthetic-history-key" },
      replaceState,
      pushState: vi.fn(),
      length: 1,
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

let appWindow: ReturnType<typeof createWindow>;
let restart: typeof import("./desktopUpdateRestart");

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  appWindow = createWindow();
  vi.stubGlobal("window", appWindow);
  restart = await import("./desktopUpdateRestart");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function readHandoff() {
  return appWindow.localStorage.getItem(restart.DESKTOP_UPDATE_RETURN_ROUTE_STORAGE_KEY);
}

function writeHandoff(value: string) {
  appWindow.localStorage.setItem(restart.DESKTOP_UPDATE_RETURN_ROUTE_STORAGE_KEY, value);
}

describe("desktop update return route", () => {
  it.each(["", "#/"])(
    "restores the scoped conversation before hash history starts at %j, once",
    async (launchHash) => {
      const route = "#/remote-environment/shared-thread?diff=all#checkpoint-7";
      appWindow.location.hash = route;
      const result = await restart.installDesktopUpdate(async () => {
        expect(readHandoff()).not.toBeNull();
        return acceptedInstall;
      });
      expect(result).toBe(acceptedInstall);

      const storage = appWindow.localStorage;
      appWindow = createWindow();
      appWindow.localStorage = storage;
      appWindow.location.hash = launchHash;
      vi.stubGlobal("window", appWindow);
      vi.resetModules();
      restart = await import("./desktopUpdateRestart");
      restart.restoreDesktopUpdateReturnRoute();
      expect(appWindow.history.replaceState).toHaveBeenCalledExactlyOnceWith(
        appWindow.history.state,
        "",
        route,
      );
      const history = createHashHistory({ window: appWindow });
      expect(history.location).toMatchObject({
        pathname: "/remote-environment/shared-thread",
        search: "?diff=all",
        hash: "#checkpoint-7",
      });
      expect(appWindow.history.length).toBe(1);
      expect(appWindow.history.state).toEqual({ key: "synthetic-history-key" });
      expect(readHandoff()).toBeNull();
      history.destroy();

      appWindow.location.hash = "";
      restart.restoreDesktopUpdateReturnRoute();
      expect(appWindow.location.hash).toBe("");
    },
  );

  it.each([
    "#/primary/thread-7",
    "#/environment%3Aremote/thread%3A7?diff=all",
    "#/draft/draft-7",
    "#/settings/general?environment=remote-environment",
  ])("preserves the complete internal route %s", async (route) => {
    appWindow.location.hash = route;
    await restart.installDesktopUpdate(async () => acceptedInstall);
    appWindow.location.hash = "";

    restart.restoreDesktopUpdateReturnRoute();

    expect(appWindow.location.hash).toBe(route);
    expect(readHandoff()).toBeNull();
  });

  it.each([
    "#/other-environment/shared-thread",
    "#/new",
    "#/settings/general",
    "#/?panel=connections",
    "#codex-auth=synthetic-delivery",
  ])("gives the explicit launch route %s precedence and discards the handoff", async (route) => {
    appWindow.location.hash = "#/remote-environment/thread-7";
    await restart.installDesktopUpdate(async () => acceptedInstall);
    appWindow.location.hash = route;

    restart.restoreDesktopUpdateReturnRoute();

    expect(appWindow.location.hash).toBe(route);
    expect(appWindow.history.replaceState).not.toHaveBeenCalled();
    expect(readHandoff()).toBeNull();
    appWindow.location.hash = "";
    restart.restoreDesktopUpdateReturnRoute();
    expect(appWindow.location.hash).toBe("");
  });

  it.each([10 * 60_000, 60 * 60_000, -1])("discards a handoff with age %i ms", async (elapsed) => {
    appWindow.location.hash = "#/remote-environment/thread-7";
    await restart.installDesktopUpdate(async () => acceptedInstall);
    appWindow.location.hash = "";
    vi.setSystemTime(Date.now() + elapsed);

    restart.restoreDesktopUpdateReturnRoute();

    expect(appWindow.location.hash).toBe("");
    expect(readHandoff()).toBeNull();
  });

  it.each([
    "invalid JSON",
    "null",
    JSON.stringify({ hash: "#/remote-environment/thread-7", savedAt: "recent" }),
    JSON.stringify({
      hash: "https://example.invalid/thread-7",
      savedAt: Date.parse("2026-01-01T00:00:00Z"),
    }),
    JSON.stringify({
      hash: "#//example.invalid/thread-7",
      savedAt: Date.parse("2026-01-01T00:00:00Z"),
    }),
  ])("ignores and clears malformed persisted data: %s", (value) => {
    writeHandoff(value);

    restart.restoreDesktopUpdateReturnRoute();

    expect(appWindow.location.hash).toBe("");
    expect(readHandoff()).toBeNull();
  });

  it("keeps a normal startup at its launch route without a handoff", () => {
    restart.restoreDesktopUpdateReturnRoute();

    expect(appWindow.location.hash).toBe("");
    expect(appWindow.history.replaceState).not.toHaveBeenCalled();
  });

  it.each(["", "#/", "#codex-auth=synthetic-delivery"])(
    "clears any old route when installation starts from %j",
    async (route) => {
      writeHandoff(JSON.stringify({ hash: "#/old-environment/thread-7", savedAt: Date.now() }));
      appWindow.location.hash = route;
      await restart.installDesktopUpdate(async () => acceptedInstall);
      appWindow.location.hash = "";

      restart.restoreDesktopUpdateReturnRoute();

      expect(appWindow.location.hash).toBe("");
      expect(readHandoff()).toBeNull();
    },
  );

  it.each([
    { ...acceptedInstall, accepted: false },
    {
      ...acceptedInstall,
      state: { ...downloadedState, message: "Installer failed", errorContext: "install" as const },
    },
    { ...acceptedInstall, state: { ...downloadedState, status: "error" as const } },
  ])("discards the route when installation is refused or fails: %j", async (result) => {
    appWindow.location.hash = "#/remote-environment/thread-7";

    expect(await restart.installDesktopUpdate(async () => result)).toBe(result);
    expect(readHandoff()).toBeNull();
    appWindow.location.hash = "";
    restart.restoreDesktopUpdateReturnRoute();
    expect(appWindow.location.hash).toBe("");
  });

  it.each([true, false])(
    "restores the route only when the install retry succeeds: %j",
    async (succeeds) => {
      const failedInstall: DesktopUpdateActionResult = {
        ...acceptedInstall,
        state: { ...downloadedState, message: "Installer failed", errorContext: "install" },
      };
      const route = "#/remote-environment/thread-7?diff=all";
      appWindow.location.hash = route;

      await restart.installDesktopUpdate(async () => failedInstall);
      expect(readHandoff()).toBeNull();

      await restart.installDesktopUpdate(async () => (succeeds ? acceptedInstall : failedInstall));
      if (succeeds) expect(readHandoff()).not.toBeNull();
      else expect(readHandoff()).toBeNull();

      appWindow.location.hash = "";
      restart.restoreDesktopUpdateReturnRoute();
      expect(appWindow.location.hash).toBe(succeeds ? route : "");
      expect(readHandoff()).toBeNull();
    },
  );

  it.each(["synchronous", "asynchronous"])(
    "clears the handoff and preserves a %s installation error",
    async (mode) => {
      appWindow.location.hash = "#/remote-environment/thread-7";
      const error = new Error("Install IPC failed");

      await expect(
        restart.installDesktopUpdate(() => {
          if (mode === "synchronous") throw error;
          return Promise.reject(error);
        }),
      ).rejects.toBe(error);

      expect(readHandoff()).toBeNull();
    },
  );

  it("does not save or restore desktop routes in a web client", async () => {
    appWindow.desktopBridge = undefined;
    vi.resetModules();
    restart = await import("./desktopUpdateRestart");
    const stale = JSON.stringify({ hash: "#/remote-environment/thread-7", savedAt: Date.now() });
    writeHandoff(stale);
    appWindow.location.hash = "#/web-environment/thread-7";
    const install = vi.fn(async () => acceptedInstall);

    expect(await restart.installDesktopUpdate(install)).toBe(acceptedInstall);
    expect(install).toHaveBeenCalledOnce();
    expect(readHandoff()).toBe(stale);
    appWindow.location.hash = "";
    restart.restoreDesktopUpdateReturnRoute();
    expect(appWindow.location.hash).toBe("");
    expect(readHandoff()).toBe(stale);
  });

  it("continues the install when route storage is unavailable", async () => {
    appWindow.location.hash = "#/remote-environment/thread-7";
    Object.defineProperty(appWindow, "localStorage", {
      get() {
        throw new DOMException("Storage blocked", "SecurityError");
      },
    });
    const install = vi.fn(async () => acceptedInstall);

    expect(await restart.installDesktopUpdate(install)).toBe(acceptedInstall);
    expect(install).toHaveBeenCalledOnce();
    appWindow.location.hash = "";
    expect(() => restart.restoreDesktopUpdateReturnRoute()).not.toThrow();
    expect(appWindow.location.hash).toBe("");
  });
});
