import type { ScopedThreadRef, PreviewSessionSnapshot } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { openTerminalLinkInPreview } from "./openTerminalLinkInPreview";

const openBrowser = vi.fn();

vi.mock("~/previewStateStore", () => ({
  applyPreviewServerSnapshot: vi.fn(),
  isPreviewSupportedInRuntime: () => true,
}));

vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({ openBrowser }),
  },
}));

const browserDefaultsMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

vi.mock("~/browser/browserDefaults", () => ({
  resolveBrowserDefaults: browserDefaultsMocks.resolve,
  browserDefaultOpenViewport: (defaults: { viewport: unknown }) => defaults.viewport,
  browserDefaultOpenProfileId: (defaults: { profileId: string }) => defaults.profileId,
}));

const linkTargetMocks = vi.hoisted(() => ({
  preference: vi.fn<() => "system" | "app">(),
}));

vi.mock("~/browser/browserLinkTarget", () => ({
  resolveBrowserLinkTargetPreference: async () => linkTargetMocks.preference(),
  isWebUrl: (url: string) => /^https?:/u.test(url),
}));

const hydratedDefaults = {
  viewport: { _tag: "fixed", width: 1280, height: 720 } as const,
  profileId: "work",
};

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

beforeEach(() => {
  browserDefaultsMocks.resolve.mockReset();
  browserDefaultsMocks.resolve.mockResolvedValue(hydratedDefaults);
  linkTargetMocks.preference.mockReturnValue("app");
});

afterEach(() => {
  vi.restoreAllMocks();
  openBrowser.mockClear();
});

const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "tab-1",
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-06-20T00:00:00.000Z",
};

describe("openTerminalLinkInPreview", () => {
  it("opens loopback links on the environment even when the system browser is configured", async () => {
    linkTargetMocks.preference.mockReturnValue("system");
    const fallbackToBrowser = vi.fn();
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));

    await openTerminalLinkInPreview({
      url: "http://localhost:3000/",
      threadRef,
      openPreview,
      fallbackToBrowser,
      forceBrowser: false,
    });

    expect(openPreview).toHaveBeenCalledOnce();
    expect(fallbackToBrowser).not.toHaveBeenCalled();
  });

  it("opens a loopback link in the integrated browser without asking which browser to use", async () => {
    const fallbackToBrowser = vi.fn();
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));

    await openTerminalLinkInPreview({
      url: "http://localhost:3000/path",
      threadRef,
      openPreview,
      fallbackToBrowser,
      forceBrowser: false,
    });

    expect(openPreview).toHaveBeenCalledWith({
      environmentId: "local",
      input: {
        threadId: "thread-1",
        url: "http://localhost:3000/path",
        viewport: hydratedDefaults.viewport,
        profileId: hydratedDefaults.profileId,
      },
    });
    expect(openBrowser).toHaveBeenCalledWith(threadRef, "tab-1");
    expect(fallbackToBrowser).not.toHaveBeenCalled();
  });

  it("sends public links to the system browser when configured", async () => {
    linkTargetMocks.preference.mockReturnValue("system");
    const fallbackToBrowser = vi.fn();
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));

    await openTerminalLinkInPreview({
      url: "https://example.com/docs",
      threadRef,
      openPreview,
      fallbackToBrowser,
      forceBrowser: false,
    });

    expect(fallbackToBrowser).toHaveBeenCalledOnce();
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("does not report or fall back when opening the preview is interrupted", async () => {
    const fallbackToBrowser = vi.fn();
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await openTerminalLinkInPreview({
      url: "http://localhost:5173/",
      threadRef,
      openPreview: async () => AsyncResult.failure(Cause.interrupt()),
      fallbackToBrowser,
      forceBrowser: false,
    });

    expect(reportError).not.toHaveBeenCalled();
    expect(fallbackToBrowser).not.toHaveBeenCalled();
  });
});
