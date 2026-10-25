import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ChatCanvasContext } from "../chat/ChatCanvasContext";
import { resolveChatCanvasLayout } from "../chat/chatCanvasLayout";
import {
  type PreviewMiniPlayerSource,
  previewMiniPlayerSourceKey,
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";

const setActivePreviewTab = vi.fn();
vi.mock(import("~/previewStateStore"), async (original) => ({
  ...(await original()),
  setActivePreviewTab: ((...args: unknown[]) => setActivePreviewTab(...args)) as never,
  useThreadPreviewState: (() => ({
    sessions: { "tab-1": { viewport: { _tag: "freeform", width: 1600, height: 1000 } } },
    serverEpoch: null,
    desktopByTabId: {},
  })) as never,
}));
vi.mock(import("~/browser/browserRecording"), async (original) => ({
  ...(await original()),
  useActiveBrowserRecordingTabIds: (() => new Set()) as never,
  findActiveBrowserRecordingRuntimeTabId: (() => null) as never,
}));
vi.mock(import("~/browser/BrowserSurfaceSlot"), async (original) => ({
  ...(await original()),
  BrowserSurfaceSlot: (() => null) as never,
}));
vi.mock(import("../device/DeviceStreamView"), async (original) => ({
  ...(await original()),
  DeviceStreamView: (() => null) as never,
}));
vi.mock(import("~/state/device"), async (original) => ({
  ...(await original()),
  useDeviceState: (() => ({ state: { devices: [], hosts: [] } })) as never,
}));
const reportForkClientUsage = vi.fn();
vi.mock(import("~/forkClientUsage"), async (original) => ({
  ...(await original()),
  reportForkClientUsage: ((...args: unknown[]) => reportForkClientUsage(...args)) as never,
}));
import { PREVIEW_MINI_PLAYER_EDGE_GAP } from "./previewMiniPlayerLayout";
import { ThreadPreviewMiniPlayer } from "./ThreadPreviewMiniPlayer";

const threadRef = {
  environmentId: EnvironmentId.make("preview-test"),
  threadId: ThreadId.make("thread-test"),
};
const container = { width: 900, height: 700 };
const browserSource: PreviewMiniPlayerSource = { kind: "browser", tabId: "tab-1" };
const deviceSource: PreviewMiniPlayerSource = {
  kind: "device",
  hostId: "host-1",
  deviceId: "emulator-5554",
  platform: "android",
  name: "Pixel",
};
// Matches the size each source reports before its content loads.
const sourceSizes = {
  browser: { width: 1600, height: 1000 },
  device: { width: 1000, height: 1000 / (9 / 20) },
};

function Player() {
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef),
  );
  if (!miniPlayer) return null;
  const key = previewMiniPlayerSourceKey(miniPlayer.source);
  return (
    <ChatCanvasContext
      value={{
        container,
        lane: { padding: 20, minChatWidth: 640 },
        previewKey: key,
        layout: resolveChatCanvasLayout({
          container,
          preview: { ...miniPlayer, key, source: sourceSizes[miniPlayer.source.kind] },
        }),
        resolvePreviewFrame: (position) =>
          resolveChatCanvasLayout({
            container,
            preview: {
              ...miniPlayer,
              position,
              key,
              source: sourceSizes[miniPlayer.source.kind],
            },
          }).frame,
        reportPreview: () => {},
        clearPreview: () => {},
        registerTimeline: () => {},
        reportDetailsCard: () => {},
        detailsCardTopInset: 0,
      }}
    >
      <ThreadPreviewMiniPlayer threadRef={threadRef} miniPlayer={miniPlayer} />
    </ChatCanvasContext>
  );
}

let root: Root;
let host: HTMLDivElement;
let captured: Set<number>;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Reduced motion makes a release settle immediately instead of over animation frames.
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduced-motion") }));
  captured = new Set();
});

afterEach(async () => {
  await act(() => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(source = browserSource) {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  usePreviewMiniPlayerStore.getState().open(threadRef, source);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(() => root.render(<Player />));
}

function frame() {
  const element = host.querySelector<HTMLElement>("section")!;
  return {
    x: Number.parseFloat(element.style.left),
    y: Number.parseFloat(element.style.top),
    width: Number.parseFloat(element.style.width),
    height: Number.parseFloat(element.style.height),
  };
}

function shield() {
  return host.querySelector<HTMLElement>("section > div[aria-hidden='true']")!;
}

async function pointer(element: Element, type: string, x: number, y: number) {
  // Synthetic events have no active pointer for the browser to capture.
  Object.assign(element, {
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
  });
  await act(() => {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
    Object.defineProperty(event, "pointerId", { value: 1 });
    // Back-to-back synthetic events would otherwise read as a fling.
    Object.defineProperty(event, "timeStamp", { value: 1 });
    element.dispatchEvent(event);
  });
}

describe("floating browser preview gestures", () => {
  it("moves from its page surface on a narrow canvas, retains size, and stops on release", async () => {
    await mount();
    const start = frame();
    const surface = shield();
    await pointer(surface, "pointerdown", 700, 550);
    await pointer(surface, "pointermove", 450, 450);
    expect(frame()).toEqual({ ...start, x: start.x - 250, y: start.y - 100 });
    await pointer(surface, "pointerup", 450, 450);
    expect(captured.size).toBe(0);
    const released = frame();
    await pointer(surface, "pointermove", 300, 300);
    expect(frame()).toEqual(released);
  });

  it("settles flush against an edge it is dropped near and reports how it settled", async () => {
    reportForkClientUsage.mockClear();
    await mount();
    const start = frame();
    const surface = shield();
    await pointer(surface, "pointerdown", 700, 550);
    await pointer(surface, "pointermove", 700 - (start.x - 300), 550 - (start.y - 30));
    expect(frame()).toMatchObject({ x: 300, y: 30 });
    await pointer(surface, "pointerup", 700 - (start.x - 300), 550 - (start.y - 30));
    expect(frame()).toMatchObject({ x: 300, y: PREVIEW_MINI_PLAYER_EDGE_GAP });
    expect(reportForkClientUsage.mock.calls).toEqual([
      [
        threadRef.environmentId,
        { feature: "floating-preview", action: "released", settle: "edge", preview: "browser" },
      ],
    ]);
  });

  it("keeps anchored edge resizing usable and stops a cancelled gesture", async () => {
    await mount();
    const start = frame();
    const edge = host.querySelector("[data-preview-mini-player-resize='west']")!;
    await pointer(edge, "pointerdown", 580, 550);
    await pointer(edge, "pointermove", 540, 550);
    expect(frame().width).toBe(start.width + 40);
    expect(frame().x + frame().width).toBe(start.x + start.width);
    await pointer(edge, "pointercancel", 540, 550);
    const cancelled = frame();
    await pointer(edge, "pointermove", 400, 550);
    expect(frame()).toEqual(cancelled);
    expect(captured.size).toBe(0);
  });

  it("closes through its toolbar without moving the preview", async () => {
    await mount();
    const start = frame();
    const close = host.querySelector("button[aria-label='Close floating preview']")!;
    await pointer(close, "pointerdown", 870, 500);
    await pointer(close, "pointermove", 600, 300);
    expect(frame()).toEqual(start);
    await act(() => close.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(host.querySelector("section")).toBeNull();
  });

  it("opens in the right panel as the thread's active browser tab", async () => {
    await mount();
    useRightPanelStore.setState({ byThreadKey: {} });
    const open = host.querySelector("button[aria-label='Open preview in right panel']")!;
    await act(() => open.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(host.querySelector("section")).toBeNull();
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toMatchObject({ kind: "preview", resourceId: "tab-1" });
    expect(setActivePreviewTab).toHaveBeenCalledWith(threadRef, "tab-1");
  });

  it("opens the floating tab in the right panel on double-click", async () => {
    await mount();
    useRightPanelStore.setState({ byThreadKey: {} });
    await act(() => shield().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(host.querySelector("section")).toBeNull();
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toMatchObject({ kind: "preview", resourceId: "tab-1" });
  });
});

describe("floating device preview", () => {
  it("keeps the stream out of reach and moves from its surface", async () => {
    await mount(deviceSource);
    const stream = host.querySelector<HTMLElement>("section [inert]")!;
    expect(stream.className).toContain("pointer-events-none");
    const start = frame();
    const surface = shield();
    await pointer(surface, "pointerdown", start.x + 40, start.y + 80);
    await pointer(surface, "pointermove", start.x + 10, start.y + 60);
    expect(frame()).toEqual({ ...start, x: start.x - 30, y: start.y - 20 });
    await pointer(surface, "pointerup", start.x + 10, start.y + 60);
    expect(captured.size).toBe(0);
  });

  it("opens the device in the right panel on double-click", async () => {
    await mount(deviceSource);
    useRightPanelStore.setState({ byThreadKey: {} });
    await act(() => shield().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(host.querySelector("section")).toBeNull();
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toMatchObject({
      kind: "device",
      target: { hostId: "host-1", deviceId: "emulator-5554", platform: "android", name: "Pixel" },
    });
  });
});
