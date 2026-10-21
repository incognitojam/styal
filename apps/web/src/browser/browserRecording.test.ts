import {
  DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER,
  EnvironmentId,
  ThreadId,
  type DesktopPreviewBridge,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const {
  captureScreenshot,
  clientSettings,
  events,
  getDisplayMedia,
  registrySet,
  requestDisplayMediaCapture,
  save,
  startScreencast,
  stopScreencast,
  waitForBrowserCaptureSurface,
} = vi.hoisted(() => {
  const events: string[] = [];
  return {
    captureScreenshot: vi.fn<DesktopPreviewBridge["captureScreenshot"]>(),
    clientSettings: { browserRecordingFrameRate: 30 as 30 | 60 },
    events,
    getDisplayMedia: vi.fn(),
    requestDisplayMediaCapture: vi.fn((_tabId: string) => undefined),
    registrySet: vi.fn((_atom: unknown, value: { readonly tabIds: ReadonlySet<string> }) => {
      events.push(
        value.tabIds.size === 0 ? "clear" : `publish:${Array.from(value.tabIds).join(",")}`,
      );
    }),
    save: vi.fn(async (tabId: string) => ({
      id: "recording-test",
      tabId,
      path: "/tmp/recording-test.webm",
      mimeType: "video/webm" as const,
      sizeBytes: 0,
      createdAt: "2026-06-26T00:00:00.000Z",
    })),
    startScreencast: vi.fn<DesktopPreviewBridge["recording"]["startScreencast"]>(async (_tabId) => {
      events.push("start-screencast");
    }),
    stopScreencast: vi.fn(async () => undefined),
    waitForBrowserCaptureSurface: vi.fn(async () => true),
  };
});

vi.mock(import("~/components/preview/previewBridge"), async (original) => {
  vi.stubGlobal("window", {
    desktopBridge: {
      preview: {
        captureScreenshot,
        recording: {
          onFrame: vi.fn(),
          save,
          startScreencast: async (tabId: string) => {
            const result = await startScreencast(tabId);
            if (result === undefined) requestDisplayMediaCapture(tabId);
            return result;
          },
          stopScreencast,
        },
      },
    },
  });
  try {
    return await original();
  } finally {
    vi.unstubAllGlobals();
  }
});

vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: { set: registrySet },
}));

vi.mock("./browserCaptureSurface", () => ({
  BROWSER_CAPTURE_SURFACE_TIMEOUT_MS: 5_000,
  waitForBrowserCaptureSurface,
}));

vi.mock("~/hooks/useSettings", () => ({
  ensureClientSettingsHydrated: vi.fn(async () => undefined),
  getClientSettings: () => clientSettings,
}));

import {
  BROWSER_RECORDING_MEDIA_CAPTURE_TIMEOUT_MS,
  BrowserRecordingConflictError,
  findActiveBrowserRecordingRuntimeTabId,
  readActiveBrowserRecordingTabIds,
  readActiveBrowserRecordingTargets,
  startBrowserRecording,
  stopBrowserRecording,
  stopBrowserRecordingForUpload,
  BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS,
} from "./browserRecording";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { previewRuntimeTabId } from "./previewRuntimeTabId";
import { ensureClientSettingsHydrated } from "~/hooks/useSettings";

class FakeMediaRecorder {
  static readonly instances: FakeMediaRecorder[] = [];
  static supportedTypes = new Set(["video/webm;codecs=vp9"]);
  static outputMimeType: string | undefined;
  static stopError: unknown;
  static isTypeSupported(type: string): boolean {
    return this.supportedTypes.has(type);
  }

  state: RecordingState = "inactive";
  readonly mimeType: string;
  readonly stream: MediaStream;
  readonly options: MediaRecorderOptions | undefined;
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    this.stream = stream;
    this.options = options;
    this.mimeType =
      FakeMediaRecorder.outputMimeType ?? options?.mimeType ?? "video/browser-default";
    FakeMediaRecorder.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    if (FakeMediaRecorder.stopError !== undefined) throw FakeMediaRecorder.stopError;
    this.state = "inactive";
    for (const listener of this.listeners.get("stop") ?? []) {
      if (typeof listener === "function") listener(new Event("stop"));
      else listener.handleEvent(new Event("stop"));
    }
  }
}

describe("browser recording", () => {
  let animationFrameCount = 0;

  beforeEach(() => {
    events.length = 0;
    vi.clearAllMocks();
    FakeMediaRecorder.instances.length = 0;
    FakeMediaRecorder.supportedTypes = new Set(["video/webm;codecs=vp9"]);
    FakeMediaRecorder.outputMimeType = undefined;
    FakeMediaRecorder.stopError = undefined;
    clientSettings.browserRecordingFrameRate = 30;
    animationFrameCount = 0;
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrameCount += 1;
      callback(animationFrameCount);
      return animationFrameCount;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder as unknown as typeof MediaRecorder);
    getDisplayMedia.mockResolvedValue({
      getVideoTracks: () => [],
      getTracks: () => [{ stop: vi.fn() }],
    });
    requestDisplayMediaCapture.mockImplementation((tabId: string) => {
      const trigger = Reflect.get(globalThis, DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER);
      if (typeof trigger !== "function" || trigger(tabId) !== true) {
        throw new Error(`No pending display-media capture for ${tabId}.`);
      }
    });
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });
    useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("saves locally and releases capture before transferring the encoded recording once", async () => {
    const stopTrack = vi.fn();
    getDisplayMedia.mockResolvedValue({
      getVideoTracks: () => [],
      getTracks: () => [{ stop: stopTrack }],
    });
    await startBrowserRecording("transfer-tab");
    let finishUpload!: () => void;
    const uploaded = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    const transfer = vi.fn(async (artifact, blob: Blob) => {
      expect(save).toHaveBeenCalledOnce();
      expect(stopTrack).toHaveBeenCalled();
      expect(artifact.path).toBe("/tmp/recording-test.webm");
      expect(blob.type).toBe("video/webm;codecs=vp9");
      await uploaded;
      return "uploaded-recording";
    });
    const localStop = stopBrowserRecording("transfer-tab");
    const firstStop = stopBrowserRecordingForUpload("transfer-tab", transfer);
    const secondStop = stopBrowserRecordingForUpload("transfer-tab", transfer);
    finishUpload();
    expect(await firstStop).toEqual(await secondStop);
    expect((await firstStop)?.uploadedAttachmentId).toBe("uploaded-recording");
    expect((await localStop)?.path).toBe("/tmp/recording-test.webm");
    expect(transfer).toHaveBeenCalledOnce();
  });

  it("keeps the saved desktop file and releases the recording when transfer fails", async () => {
    await startBrowserRecording("failed-transfer-tab");
    await expect(
      stopBrowserRecordingForUpload("failed-transfer-tab", async () => {
        throw new Error("Connection interrupted");
      }),
    ).rejects.toThrow("Connection interrupted");
    expect(save).toHaveBeenCalledOnce();
    expect(readActiveBrowserRecordingTabIds().has("failed-transfer-tab")).toBe(false);
    await startBrowserRecording("failed-transfer-tab");
    await stopBrowserRecording("failed-transfer-tab");
  });

  it("paints and holds a hidden browser surface for the recording lifetime", async () => {
    startScreencast.mockImplementationOnce(async (tabId: string) => {
      expect(animationFrameCount).toBe(2);
      expect(useBrowserSurfaceStore.getState().activityByTabId[tabId]).toBe(1);
      expect(useBrowserSurfaceStore.getState().byTabId[tabId]?.captureCount).toBe(1);
    });
    getDisplayMedia.mockImplementationOnce(async () => {
      expect(animationFrameCount).toBe(2);
      expect(useBrowserSurfaceStore.getState().activityByTabId["background-tab"]).toBe(1);
      expect(useBrowserSurfaceStore.getState().byTabId["background-tab"]?.captureCount).toBe(1);
      return { getVideoTracks: () => [], getTracks: () => [{ stop: vi.fn() }] };
    });

    await startBrowserRecording("background-tab");
    expect(useBrowserSurfaceStore.getState().activityByTabId["background-tab"]).toBe(1);
    expect(useBrowserSurfaceStore.getState().byTabId["background-tab"]?.captureCount).toBe(1);

    await stopBrowserRecording("background-tab");
    expect(useBrowserSurfaceStore.getState().activityByTabId["background-tab"]).toBeUndefined();
    expect(useBrowserSurfaceStore.getState().byTabId["background-tab"]?.captureCount).toBe(0);
  });

  it("releases the capture surface when presentation fails", async () => {
    waitForBrowserCaptureSurface.mockResolvedValueOnce(false);

    await expect(startBrowserRecording("recording-tab")).rejects.toMatchObject({
      operation: "prepare-capture-surface",
      tabId: "recording-tab",
    });

    expect(startScreencast).not.toHaveBeenCalled();
    expect(useBrowserSurfaceStore.getState().activityByTabId["recording-tab"]).toBeUndefined();
    expect(useBrowserSurfaceStore.getState().byTabId["recording-tab"]?.captureCount).toBe(0);
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
  });

  it("stops the native stream when MediaRecorder cleanup fails", async () => {
    const stopTrack = vi.fn();
    getDisplayMedia.mockResolvedValueOnce({
      getVideoTracks: () => [],
      getTracks: () => [{ stop: stopTrack }],
    });

    await startBrowserRecording("recording-tab");
    const cleanupCause = new DOMException("Could not start video source", "NotReadableError");
    FakeMediaRecorder.stopError = cleanupCause;

    await expect(stopBrowserRecording("recording-tab")).rejects.toMatchObject({
      operation: "cleanup",
      tabId: "recording-tab",
      message: "Browser recording operation cleanup failed for tab recording-tab.",
    });
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("releases the native capture lease when stream acquisition fails", async () => {
    const cause = new Error("capture failed");
    cause.name = "NotReadableError";
    getDisplayMedia.mockRejectedValueOnce(cause);

    await expect(startBrowserRecording("recording-tab")).rejects.toMatchObject({
      operation: "capture-media-stream",
      tabId: "recording-tab",
      cause,
      message: "Browser recording operation capture-media-stream failed for tab recording-tab.",
    });

    expect(stopScreencast).toHaveBeenCalledWith("recording-tab");
    expect(useBrowserSurfaceStore.getState().byTabId["recording-tab"]?.captureCount).toBe(0);
    expect(events.at(-1)).toBe("clear");
  });

  it("records separate tabs concurrently", async () => {
    const firstThreadRef = {
      environmentId: EnvironmentId.make("environment-recording"),
      threadId: ThreadId.make("thread-recording-first"),
    };
    const secondThreadRef = {
      environmentId: EnvironmentId.make("environment-recording"),
      threadId: ThreadId.make("thread-recording-second"),
    };
    await Promise.all([
      startBrowserRecording("recording-tab", firstThreadRef),
      startBrowserRecording("recording-tab-2", secondThreadRef),
    ]);

    expect(startScreencast).toHaveBeenCalledTimes(2);
    expect(events).toContain("publish:recording-tab,recording-tab-2");
    expect(readActiveBrowserRecordingTabIds()).toEqual(
      new Set(["recording-tab", "recording-tab-2"]),
    );
    expect(readActiveBrowserRecordingTabIds(firstThreadRef)).toEqual(new Set(["recording-tab"]));
    expect(readActiveBrowserRecordingTabIds(secondThreadRef)).toEqual(new Set(["recording-tab-2"]));

    await stopBrowserRecording("recording-tab");
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set(["recording-tab-2"]));
    await stopBrowserRecording("recording-tab-2");
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("keeps a recording reachable through its runtime id after a server epoch changes", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("environment-recording"),
      threadId: ThreadId.make("thread-recording-scoped"),
    };
    const runtimeTabId = previewRuntimeTabId(threadRef, "epoch-a", "tab_1");
    await startBrowserRecording(runtimeTabId, threadRef, "tab_1");

    expect(startScreencast).toHaveBeenCalledWith(runtimeTabId);
    expect(readActiveBrowserRecordingTabIds(threadRef)).toEqual(new Set([runtimeTabId]));
    expect(readActiveBrowserRecordingTargets(threadRef)).toEqual([
      { runtimeTabId, serverTabId: "tab_1" },
    ]);
    expect(findActiveBrowserRecordingRuntimeTabId(threadRef, "tab_1")).toBe(runtimeTabId);

    const replacementRuntimeTabId = previewRuntimeTabId(threadRef, "epoch-b", "tab_1");
    await expect(
      startBrowserRecording(replacementRuntimeTabId, threadRef, "tab_1"),
    ).rejects.toBeInstanceOf(BrowserRecordingConflictError);
    expect(startScreencast).toHaveBeenCalledTimes(1);

    await stopBrowserRecording(runtimeTabId);
  });

  it("finishes startup before stopping so an active recording yields an artifact", async () => {
    let finishStartingScreencast: (() => void) | undefined;
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
      await new Promise<void>((resolve) => {
        finishStartingScreencast = resolve;
      });
    });

    const startPromise = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce());

    const stopPromise = stopBrowserRecording("recording-tab");
    expect(stopScreencast).not.toHaveBeenCalled();
    expect(useBrowserSurfaceStore.getState().byTabId["recording-tab"]?.captureCount).toBe(1);
    finishStartingScreencast?.();

    await startPromise;
    await expect(stopPromise).resolves.toMatchObject({ tabId: "recording-tab" });
    expect(useBrowserSurfaceStore.getState().byTabId["recording-tab"]?.captureCount).toBe(0);
    expect(stopScreencast).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(events.at(-1)).toBe("clear");
  });

  it("lets a stop wait through a slow but healthy startup", async () => {
    vi.useFakeTimers();
    const slowStartMs = BROWSER_RECORDING_MEDIA_CAPTURE_TIMEOUT_MS + 1_000;
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
      await new Promise<void>((resolve) => window.setTimeout(resolve, slowStartMs));
    });

    const startPromise = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce());
    const stopPromise = stopBrowserRecording("recording-tab");

    await vi.advanceTimersByTimeAsync(slowStartMs);
    await startPromise;
    await expect(stopPromise).resolves.toMatchObject({ tabId: "recording-tab" });
    expect(useBrowserSurfaceStore.getState().byTabId["recording-tab"]?.captureCount).toBe(0);
    expect(save).toHaveBeenCalledOnce();
  });

  it("keeps the recording slot while a failed stop waits for startup", async () => {
    let finishStartingScreencast: (() => void) | undefined;
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
      await new Promise<void>((resolve) => {
        finishStartingScreencast = resolve;
      });
    });
    stopScreencast.mockRejectedValueOnce(new Error("initial stop failed"));

    const firstStart = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce());

    const stopPromise = stopBrowserRecording("recording-tab");
    const rejectedStop = expect(stopPromise).rejects.toMatchObject({
      operation: "stop-screencast",
      tabId: "recording-tab",
    });
    expect(stopScreencast).not.toHaveBeenCalled();
    await expect(startBrowserRecording("recording-tab")).rejects.toBeInstanceOf(
      BrowserRecordingConflictError,
    );

    finishStartingScreencast?.();
    await firstStart;
    await rejectedStop;
    expect(stopScreencast).toHaveBeenCalledOnce();
    expect(useBrowserSurfaceStore.getState().byTabId["recording-tab"]?.captureCount).toBe(0);

    await startBrowserRecording("recording-tab");
    expect(useBrowserSurfaceStore.getState().byTabId["recording-tab"]?.captureCount).toBe(1);
    await stopBrowserRecording("recording-tab");
    expect(useBrowserSurfaceStore.getState().byTabId["recording-tab"]?.captureCount).toBe(0);
  });

  it("fails a stop that waits too long for startup without freeing the recording slot", async () => {
    vi.useFakeTimers();
    let finishStartingScreencast: (() => void) | undefined;
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
      await new Promise<void>((resolve) => {
        finishStartingScreencast = resolve;
      });
    });

    const startPromise = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce());

    const stopPromise = stopBrowserRecording("recording-tab");
    await vi.advanceTimersByTimeAsync(0);
    expect(stopScreencast).not.toHaveBeenCalled();

    const rejection = expect(stopPromise).rejects.toMatchObject({
      operation: "wait-startup",
      tabId: "recording-tab",
    });
    await vi.advanceTimersByTimeAsync(BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS);

    await rejection;
    expect(save).not.toHaveBeenCalled();
    expect(useBrowserSurfaceStore.getState().byTabId["recording-tab"]?.captureCount).toBe(1);
    await expect(startBrowserRecording("recording-tab")).rejects.toBeInstanceOf(
      BrowserRecordingConflictError,
    );

    finishStartingScreencast?.();
    await vi.advanceTimersByTimeAsync(32);
    await startPromise;
    const cleanupResult = await stopBrowserRecording("recording-tab");
    expect(cleanupResult).toBeNull();
    expect(stopScreencast).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(useBrowserSurfaceStore.getState().byTabId["recording-tab"]?.captureCount).toBe(0);
    expect(events.at(-1)).toBe("clear");
  });
  it("clears a failed settings read before retrying recording", async () => {
    const tabId = "settings-read-failure-tab";
    const error = new Error("Settings read failed");
    vi.mocked(ensureClientSettingsHydrated).mockRejectedValueOnce(error);

    await expect(startBrowserRecording(tabId)).rejects.toBe(error);

    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
    expect(useBrowserSurfaceStore.getState().activityByTabId[tabId]).toBeUndefined();
    expect(startScreencast).not.toHaveBeenCalled();
    expect(stopScreencast).not.toHaveBeenCalled();
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(0);

    clientSettings.browserRecordingFrameRate = 60;
    await startBrowserRecording(tabId);

    expect(getDisplayMedia).toHaveBeenCalledWith({
      audio: false,
      video: { frameRate: { ideal: 60, max: 60 } },
    });
    await stopBrowserRecording(tabId);

    expect(startScreencast).toHaveBeenCalledOnce();
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
    expect(useBrowserSurfaceStore.getState().activityByTabId[tabId]).toBeUndefined();
  });
});
