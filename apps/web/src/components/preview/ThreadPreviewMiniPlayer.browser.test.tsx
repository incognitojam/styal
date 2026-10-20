import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
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
    sessions: {
      "tab-1": {
        navStatus: { _tag: "Idle" },
        viewport: { _tag: "freeform", width: 1600, height: 1000 },
      },
    },
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

async function mount(source = browserSource) {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  usePreviewMiniPlayerStore.getState().open(threadRef, source);
  const screen = await render(<Player />);
  const host = screen.container;
  const captured = new Set<number>();
  return {
    host,
    captured,
    frame: () => {
      const element = host.querySelector<HTMLElement>("section")!;
      return {
        x: Number.parseFloat(element.style.left),
        y: Number.parseFloat(element.style.top),
        width: Number.parseFloat(element.style.width),
        height: Number.parseFloat(element.style.height),
      };
    },
    shield: () => host.querySelector<HTMLElement>("section > div[aria-hidden='true']")!,
    pointer: async (element: Element, type: string, x: number, y: number) => {
      // Synthetic events have no active pointer for the browser to capture.
      Object.assign(element, {
        setPointerCapture: (id: number) => captured.add(id),
        hasPointerCapture: (id: number) => captured.has(id),
        releasePointerCapture: (id: number) => captured.delete(id),
      });
      await act(() => {
        const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
        Object.defineProperty(event, "pointerId", { value: 1 });
        element.dispatchEvent(event);
      });
    },
    [Symbol.asyncDispose]: () => screen[Symbol.asyncDispose](),
  };
}

describe("floating browser preview gestures", () => {
  it("moves from its page surface on a narrow canvas, retains size, and stops on release", async () => {
    await using player = await mount();
    const start = player.frame();
    const surface = player.shield();
    await player.pointer(surface, "pointerdown", 700, 550);
    await player.pointer(surface, "pointermove", 450, 450);
    expect(player.frame()).toEqual({ ...start, x: start.x - 250, y: start.y - 100 });
    await player.pointer(surface, "pointerup", 450, 450);
    expect(player.captured.size).toBe(0);
    const released = player.frame();
    await player.pointer(surface, "pointermove", 300, 300);
    expect(player.frame()).toEqual(released);
  });

  it("keeps anchored edge resizing usable and stops a cancelled gesture", async () => {
    await using player = await mount();
    const start = player.frame();
    const edge = player.host.querySelector("[data-preview-mini-player-resize='west']")!;
    await player.pointer(edge, "pointerdown", 580, 550);
    await player.pointer(edge, "pointermove", 540, 550);
    expect(player.frame().width).toBe(start.width + 40);
    expect(player.frame().x + player.frame().width).toBe(start.x + start.width);
    await player.pointer(edge, "pointercancel", 540, 550);
    const cancelled = player.frame();
    await player.pointer(edge, "pointermove", 400, 550);
    expect(player.frame()).toEqual(cancelled);
    expect(player.captured.size).toBe(0);
  });

  it("closes through its toolbar without moving the preview", async () => {
    await using player = await mount();
    const start = player.frame();
    const close = player.host.querySelector("button[aria-label='Close floating preview']")!;
    await player.pointer(close, "pointerdown", 870, 500);
    await player.pointer(close, "pointermove", 600, 300);
    expect(player.frame()).toEqual(start);
    await act(() => close.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(player.host.querySelector("section")).toBeNull();
  });

  it("opens in the right panel as the thread's active browser tab", async () => {
    await using player = await mount();
    useRightPanelStore.setState({ byThreadKey: {} });
    const open = player.host.querySelector("button[aria-label='Open preview in right panel']")!;
    await act(() => open.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(player.host.querySelector("section")).toBeNull();
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toMatchObject({ kind: "preview", resourceId: "tab-1" });
    expect(setActivePreviewTab).toHaveBeenCalledWith(threadRef, "tab-1");
  });

  it("opens the floating tab in the right panel on double-click", async () => {
    await using player = await mount();
    useRightPanelStore.setState({ byThreadKey: {} });
    await act(() => player.shield().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(player.host.querySelector("section")).toBeNull();
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toMatchObject({ kind: "preview", resourceId: "tab-1" });
  });
});

describe("floating device preview", () => {
  it("keeps the stream out of reach and moves from its surface", async () => {
    await using player = await mount(deviceSource);
    const stream = player.host.querySelector<HTMLElement>("section [inert]")!;
    expect(stream.className).toContain("pointer-events-none");
    const start = player.frame();
    const surface = player.shield();
    await player.pointer(surface, "pointerdown", start.x + 40, start.y + 80);
    await player.pointer(surface, "pointermove", start.x + 10, start.y + 60);
    expect(player.frame()).toEqual({ ...start, x: start.x - 30, y: start.y - 20 });
    await player.pointer(surface, "pointerup", start.x + 10, start.y + 60);
    expect(player.captured.size).toBe(0);
  });

  it("opens the device in the right panel on double-click", async () => {
    await using player = await mount(deviceSource);
    useRightPanelStore.setState({ byThreadKey: {} });
    await act(() => player.shield().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(player.host.querySelector("section")).toBeNull();
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toMatchObject({
      kind: "device",
      target: { hostId: "host-1", deviceId: "emulator-5554", platform: "android", name: "Pixel" },
    });
  });
});
