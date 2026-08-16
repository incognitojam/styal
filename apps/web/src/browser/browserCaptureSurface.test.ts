import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { waitForBrowserCaptureSurface } from "./browserCaptureSurface";

describe("waitForBrowserCaptureSurface", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits for the guest to paint after its capture wrapper is presented", async () => {
    const executeJavaScript = vi.fn(async () => true);
    const surface = {
      getAttribute: (name: string) => (name === "data-preview-viewport" ? "tab_hidden" : null),
    };
    const webview = {
      getAttribute: (name: string) => (name === "data-preview-tab" ? "tab_hidden" : null),
      executeJavaScript,
    };
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("document", {
      querySelectorAll: (selector: string) =>
        selector === "[data-preview-capture-surface]" ? [surface] : [webview],
    });
    const assertCurrent = vi.fn();

    await expect(waitForBrowserCaptureSurface("tab_hidden", { assertCurrent })).resolves.toBe(true);

    expect(executeJavaScript).toHaveBeenCalledWith(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
    );
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });

  it("returns false when no capture wrapper is presented before the deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("document", { querySelectorAll: () => [] });

    const presented = waitForBrowserCaptureSurface("tab_hidden", { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(116);

    await expect(presented).resolves.toBe(false);
  });

  it("bounds a guest paint check that never settles", async () => {
    vi.useFakeTimers();
    const surface = {
      getAttribute: (name: string) => (name === "data-preview-viewport" ? "tab_hidden" : null),
    };
    const webview = {
      getAttribute: (name: string) => (name === "data-preview-tab" ? "tab_hidden" : null),
      executeJavaScript: vi.fn(() => new Promise<unknown>(() => undefined)),
    };
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("document", {
      querySelectorAll: (selector: string) =>
        selector === "[data-preview-capture-surface]" ? [surface] : [webview],
    });

    const presented = waitForBrowserCaptureSurface("tab_hidden", { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(116);

    await expect(presented).resolves.toBe(false);
    expect(webview.executeJavaScript).toHaveBeenCalledOnce();
  });
});
