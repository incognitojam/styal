import { describe, expect, it } from "vite-plus/test";

import {
  HIDDEN_BROWSER_WEBVIEW_OFFSET,
  resolveHostedBrowserContentStyle,
  resolveHostedBrowserWebviewWrapperStyle,
} from "./hostedBrowserWebviewStyle";

describe("resolveHostedBrowserContentStyle", () => {
  it("uses layout zoom to preserve a logical viewport while DevTools owns CDP", () => {
    expect(
      resolveHostedBrowserContentStyle({
        left: 48,
        top: 30,
        width: 320,
        height: 180,
        scale: 1 / 6,
        viewportFallback: true,
      }),
    ).toEqual({
      left: 288,
      top: 180,
      width: 1920,
      height: 1080,
      zoom: 1 / 6,
    });
  });

  it("keeps the matched physical surface while CDP owns presentation", () => {
    expect(
      resolveHostedBrowserContentStyle({
        left: 48,
        top: 30,
        width: 320,
        height: 180,
        scale: 1 / 6,
        viewportFallback: false,
      }),
    ).toEqual({ left: 48, top: 30, width: 320, height: 180 });
  });
});

describe("resolveHostedBrowserWebviewWrapperStyle", () => {
  it("places an active webview on its presented surface", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: true,
        renderingActive: true,
        rect: { x: 12, y: 34, width: 800, height: 600 },
        hiddenSize: { width: 1280, height: 800 },
      }),
    ).toEqual({
      left: 12,
      top: 34,
      width: 800,
      height: 600,
      zIndex: 30,
      pointerEvents: "auto",
    });
  });

  it("clips a floating webview to the mini-player frame", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: true,
        renderingActive: true,
        cornerRadius: 12,
        rect: { x: 12, y: 34, width: 360, height: 203 },
        hiddenSize: { width: 1280, height: 800 },
      }),
    ).toMatchObject({
      left: 12,
      top: 34,
      width: 360,
      height: 203,
      borderRadius: 12,
    });
  });

  it("suspends painting for an inactive webview", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      renderingActive: false,
      rect: { x: 12, y: 34, width: 800, height: 600 },
      hiddenSize: { width: 393, height: 852 },
    });

    expect(style).toEqual({
      left: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      top: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      width: 393,
      height: 852,
      zIndex: -1,
      pointerEvents: "none",
      visibility: "hidden",
    });
  });

  it("keeps an active background task paintable behind the app", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      renderingActive: true,
      rect: null,
      hiddenSize: { width: 1280, height: 800 },
    });

    expect(style).toEqual({
      left: 0,
      top: 0,
      width: 1280,
      height: 800,
      zIndex: -1,
      pointerEvents: "none",
      visibility: "visible",
    });
  });

  it("keeps an inactive webview paintable without marking it as rendering-active", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      renderingActive: false,
      keepPaintableWhenInactive: true,
      rect: null,
      hiddenSize: { width: 1280, height: 800 },
    });

    expect(style).toEqual({
      left: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      top: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      width: 1280,
      height: 800,
      zIndex: -1,
      pointerEvents: "none",
      visibility: "visible",
    });
  });

  it("leases an in-window compositor surface behind the app for background capture", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: false,
        captureActive: true,
        renderingActive: true,
        rect: null,
        hiddenSize: { width: 1280, height: 800 },
      }),
    ).toEqual({
      left: 0,
      top: 0,
      width: 1280,
      height: 800,
      zIndex: -1,
      pointerEvents: "none",
      visibility: "visible",
    });
  });

  it("does not conceal a human-visible surface while capture is active", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: true,
        captureActive: true,
        renderingActive: true,
        rect: { x: 12, y: 34, width: 800, height: 600 },
        hiddenSize: { width: 1280, height: 800 },
      }),
    ).toEqual({
      left: 12,
      top: 34,
      width: 800,
      height: 600,
      zIndex: 30,
      pointerEvents: "auto",
    });
  });
});
