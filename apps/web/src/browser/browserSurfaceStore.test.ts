import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  acquireBrowserCaptureSurface,
  acquireBrowserSurface,
  acquireBrowserSurfaceActivity,
  tryAcquireBrowserSurface,
  useBrowserSurfaceStore,
  withBrowserCaptureSurface,
} from "./browserSurfaceStore";

describe("browserSurfaceStore", () => {
  beforeEach(() => {
    useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  });

  it("keeps concurrent background work active until every lease is released", () => {
    const first = acquireBrowserSurfaceActivity("background-browser");
    const second = acquireBrowserSurfaceActivity("background-browser");

    first();
    expect(useBrowserSurfaceStore.getState().activityByTabId["background-browser"]).toBe(1);

    second();
    expect(useBrowserSurfaceStore.getState().activityByTabId["background-browser"]).toBeUndefined();
  });

  it("freezes the source content dimensions for a fitted presentation", () => {
    const tabId = "fitted-browser-surface";
    const sourceOwner = Symbol("source");
    const sourceContent = {
      x: 10,
      y: 20,
      width: 1_280,
      height: 720,
      scale: 1,
      scrollLeft: 0,
      scrollTop: 0,
    };
    useBrowserSurfaceStore.getState().claim(tabId, sourceOwner, false);
    useBrowserSurfaceStore.getState().presentContent(tabId, sourceContent);

    const fittedLease = acquireBrowserSurface(tabId, true);
    useBrowserSurfaceStore.getState().presentContent(tabId, {
      ...sourceContent,
      width: 360,
      height: 203,
      scale: 0.28125,
    });

    expect(useBrowserSurfaceStore.getState().byTabId[tabId]?.fittedSourceContent).toEqual(
      sourceContent,
    );
    fittedLease.release();
  });

  it("ignores updates and releases from a stale surface lease", () => {
    const tabId = "leased-browser-surface";
    const staleRect = { x: 0, y: 0, width: 500, height: 700 };
    const liveRect = { x: 10, y: 20, width: 900, height: 640 };
    const staleLease = acquireBrowserSurface(tabId);
    staleLease.present(staleRect, true);

    const liveLease = acquireBrowserSurface(tabId);
    liveLease.present(liveRect, true);
    expect(staleLease.present(staleRect, true)).toBe(false);
    staleLease.release();

    expect(useBrowserSurfaceStore.getState().byTabId[tabId]).toMatchObject({
      rect: liveRect,
      visible: true,
    });
  });

  it("does not let a stale surface reclaim a newer presentation", () => {
    const tabId = "surface-handoff";
    const staleLease = acquireBrowserSurface(tabId, true);
    const liveLease = acquireBrowserSurface(tabId);
    const liveRect = { x: 10, y: 20, width: 900, height: 640 };
    liveLease.present(liveRect, true);
    const liveOwner = useBrowserSurfaceStore.getState().byTabId[tabId]?.owner;

    expect(staleLease.present(liveRect, true)).toBe(false);
    expect(tryAcquireBrowserSurface(tabId, true)).toBeNull();
    expect(useBrowserSurfaceStore.getState().byTabId[tabId]?.owner).toBe(liveOwner);
    expect(useBrowserSurfaceStore.getState().byTabId[tabId]).toMatchObject({
      rect: liveRect,
      visible: true,
      fitSourceContent: false,
    });

    liveLease.release();
    const recoveredLease = tryAcquireBrowserSurface(tabId, true);
    expect(recoveredLease).not.toBeNull();
    expect(recoveredLease?.present(liveRect, true)).toBe(true);
    expect(useBrowserSurfaceStore.getState().byTabId[tabId]).toMatchObject({
      rect: liveRect,
      visible: true,
      fitSourceContent: true,
    });
  });

  it("reference-counts background capture leases independently of visibility", () => {
    const tabId = "background-capture-surface";
    const first = acquireBrowserCaptureSurface(tabId);
    const second = acquireBrowserCaptureSurface(tabId);

    expect(useBrowserSurfaceStore.getState().byTabId[tabId]).toMatchObject({
      captureCount: 2,
      visible: false,
      zIndex: 30,
    });

    first.release();
    first.release();
    expect(useBrowserSurfaceStore.getState().byTabId[tabId]?.captureCount).toBe(1);

    second.release();
    expect(useBrowserSurfaceStore.getState().byTabId[tabId]?.captureCount).toBe(0);
  });

  it("releases a background capture surface when readiness or capture fails", async () => {
    const tabId = "failed-background-capture";
    await expect(
      withBrowserCaptureSurface(
        tabId,
        async () => undefined,
        async () => {
          throw new Error("capture failed");
        },
      ),
    ).rejects.toThrow("capture failed");
    expect(useBrowserSurfaceStore.getState().byTabId[tabId]?.captureCount).toBe(0);

    await expect(
      withBrowserCaptureSurface(
        tabId,
        async () => {
          throw new Error("presentation failed");
        },
        async () => "unreachable",
      ),
    ).rejects.toThrow("presentation failed");
    expect(useBrowserSurfaceStore.getState().byTabId[tabId]?.captureCount).toBe(0);
  });
});
