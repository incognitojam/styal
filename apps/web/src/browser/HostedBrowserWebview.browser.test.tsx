import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
  type ClientSettings,
  type DesktopPreviewBridge,
  type PreviewViewportSetting,
} from "@t3tools/contracts";
import type { ReactNode } from "react";

import "~/index.css";
import { describe, expect, it, vi } from "vite-plus/test";
import type { previewBridge } from "~/components/preview/previewBridge";

import { act, fakeTimers, render, stubGlobal } from "../../test/render";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  createTab: vi.fn<DesktopPreviewBridge["createTab"]>(),
  closeTab: vi.fn<DesktopPreviewBridge["closeTab"]>(),
  registerWebview: vi.fn<DesktopPreviewBridge["registerWebview"]>(),
  getPreviewConfig: vi.fn<DesktopPreviewBridge["getPreviewConfig"]>(),
  setViewportPresentation: vi.fn<DesktopPreviewBridge["setViewportPresentation"]>(),
  activeRecordings: new Set<string>(),
}));

vi.mock(import("~/localApi"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    ensureLocalApi: () => ({ ...actual.ensureLocalApi(), persistence: mocks as never }),
  };
});

vi.mock(import("./desktopTabLifetime"), { spy: true });

// The Electron desktop bridge; a browser has none.
vi.mock(import("~/components/preview/previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    registerWebview: mocks.registerWebview,
    getPreviewConfig: mocks.getPreviewConfig,
    setViewportPresentation: mocks.setViewportPresentation,
  } as unknown as NonNullable<typeof previewBridge>,
}));

vi.mock(import("~/components/preview/usePreviewBridge"), async (original) => ({
  ...(await original()),
  usePreviewBridge: () => undefined,
}));

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import * as desktopTabLifetime from "./desktopTabLifetime";
import { HostedBrowserWebview } from "./HostedBrowserWebview";

function resetStores() {
  __resetClientSettingsPersistenceForTests();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
}

function setup() {
  using stack = new DisposableStack();
  resetStores();
  stack.defer(resetStores);
  vi.mocked(desktopTabLifetime.acquireDesktopTab).mockClear();
  mocks.getClientSettings.mockReset();
  mocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  mocks.createTab.mockReset().mockResolvedValue(undefined);
  mocks.closeTab.mockReset().mockResolvedValue(undefined);
  mocks.registerWebview.mockReset().mockResolvedValue(undefined);
  mocks.getPreviewConfig.mockReset().mockResolvedValue({
    partition: "persist:t3-preview-work",
    webPreferences: "contextIsolation=yes",
    preloadUrl: null,
  });
  stack.use(vi.spyOn(console, "error").mockImplementation(() => undefined));
  return stack.move();
}

// The webview releases its desktop tab on a timer after unmount; run it before the test ends
// so it cannot land in the next one.
async function renderHost(ui: ReactNode) {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(ui));
  stack.defer(async () => {
    using _timers = fakeTimers();
    await screen.unmount();
    await vi.advanceTimersByTimeAsync(0);
  });
  const environment = stack.move();
  return Object.assign(screen, { [Symbol.asyncDispose]: () => environment.disposeAsync() });
}

describe("HostedBrowserWebview viewport layout", () => {
  const runtimeTabId = "zoom-layout-tab";
  const owner = Symbol("panel");
  const panel = { x: 0, y: 0, width: 2000, height: 1600 };

  const webview = (viewport: PreviewViewportSetting) => (
    <HostedBrowserWebview
      threadRef={{
        environmentId: EnvironmentId.make("zoom-layout"),
        threadId: ThreadId.make("zoom-layout"),
      }}
      tabId="zoom-layout"
      runtimeTabId={runtimeTabId}
      initialUrl="about:blank"
      viewport={viewport}
      viewportFallback={false}
      pictureInPicture={false}
      profileId={undefined}
      zoomFactor={1.5}
    />
  );

  async function renderViewport(viewport: PreviewViewportSetting) {
    mocks.getClientSettings.mockResolvedValue({
      ...DEFAULT_CLIENT_SETTINGS,
      browserDefaultZoomFactor: 1.5,
    });
    await act(() => ensureClientSettingsHydrated());
    await using stack = new AsyncDisposableStack();
    const screen = stack.use(await renderHost(webview(viewport)));
    const guest = screen.container.querySelector("webview");
    expect(guest).not.toBeNull();
    const environment = stack.move();
    return Object.assign(screen, {
      guest: guest!,
      setViewport: (next: PreviewViewportSetting) => screen.rerender(webview(next)),
      [Symbol.asyncDispose]: () => environment.disposeAsync(),
    });
  }

  it("keeps fixed viewports sized in guest pixels across host zoom and fitted surfaces", async () => {
    using _setup = setup();
    let windowZoom = 1.25;
    using _bridge = stubGlobal("desktopBridge", { getWindowZoomFactor: () => windowZoom });
    useBrowserSurfaceStore.getState().claim(runtimeTabId, owner, false);
    useBrowserSurfaceStore.getState().present(runtimeTabId, owner, panel, true, 0, 30);
    await using screen = await renderViewport({ _tag: "freeform", width: 800, height: 600 });
    const { guest } = screen;
    expect(guest.getBoundingClientRect()).toMatchObject({ width: 960, height: 720 });

    windowZoom = 0.75;
    await act(() => window.dispatchEvent(new Event("resize")));
    expect(guest.getBoundingClientRect()).toMatchObject({ width: 1600, height: 1200 });

    windowZoom = 1;
    await act(() => window.dispatchEvent(new Event("resize")));
    expect(guest.getBoundingClientRect()).toMatchObject({ width: 1200, height: 900 });

    windowZoom = 1.25;
    await act(() => window.dispatchEvent(new Event("resize")));
    await screen.setViewport({ _tag: "preset", presetId: "iphone-se", width: 375, height: 667 });
    expect(guest.getBoundingClientRect().width).toBe(450);
    expect(guest.getBoundingClientRect().height).toBeCloseTo(800.4, 1);

    const miniPlayer = Symbol("mini-player");
    await act(() => {
      useBrowserSurfaceStore.getState().claim(runtimeTabId, miniPlayer, true);
      useBrowserSurfaceStore
        .getState()
        .present(runtimeTabId, miniPlayer, { x: 0, y: 0, width: 225, height: 401 }, true, 0, 48);
    });
    expect(guest.offsetWidth).toBe(225);
    expect(guest.offsetHeight).toBe(400);
    expect(guest.getAttribute("data-preview-css-width")).toBe("375");
    expect(guest.getAttribute("data-preview-css-height")).toBe("667");
    expect(guest.getBoundingClientRect().width).toBe(225);
    expect(guest.getBoundingClientRect().height).toBeCloseTo(400.2, 1);
    // The desktop multiplies the scale by the 1.25 window zoom to fit 225 host pixels.
    await vi.waitFor(() =>
      expect(mocks.setViewportPresentation).toHaveBeenLastCalledWith(runtimeTabId, {
        width: 375,
        height: 667,
        scale: expect.closeTo(0.4, 5),
      }),
    );

    await act(() => {
      useBrowserSurfaceStore.getState().claim(runtimeTabId, owner, false);
      useBrowserSurfaceStore.getState().present(runtimeTabId, owner, panel, true, 0, 30);
    });
    await screen.setViewport(FILL_PREVIEW_VIEWPORT);
    expect(guest.getBoundingClientRect()).toMatchObject({ width: 2000, height: 1600 });
    expect(mocks.createTab).toHaveBeenCalledExactlyOnceWith(runtimeTabId, {
      zoomFactor: 1.5,
      colorScheme: DEFAULT_CLIENT_SETTINGS.browserDefaultAppearance,
    });
  });
});
