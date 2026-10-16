// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vite-plus/test";

import { createWebBuildUpdateUsage, observeWebBuildUpdateNotice } from "./webBuildUpdateUsage";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("counts each build exposure once and keeps its refresh on the original environment", async () => {
  const firstEnvironment = vi.fn(async () => {});
  const secondEnvironment = vi.fn(async () => {});
  const reload = vi.fn();
  const usage = createWebBuildUpdateUsage(reload);
  usage.noticeShown("build-b", firstEnvironment);
  usage.noticeShown("build-b", firstEnvironment);
  usage.noticeShown("build-c", secondEnvironment);
  usage.noticeShown("build-b", secondEnvironment);
  await usage.refresh("build-b", secondEnvironment);
  expect(firstEnvironment.mock.calls).toEqual([["notice_shown"], ["refresh_requested"]]);
  expect(secondEnvironment.mock.calls).toEqual([["notice_shown"]]);
  expect(reload).toHaveBeenCalledOnce();
});

it("can report a still-visible notice after a supported environment becomes available", async () => {
  const report = vi.fn(async () => {});
  const usage = createWebBuildUpdateUsage(() => {});
  usage.noticeShown("build-b", undefined);
  usage.noticeShown("build-b", report);
  await Promise.resolve();
  expect(report.mock.calls).toEqual([["notice_shown"]]);
});

it("refreshes immediately without a paired server or telemetry capability", async () => {
  const reload = vi.fn();
  const usage = createWebBuildUpdateUsage(reload);
  await usage.refresh("build-b", undefined);
  expect(reload).toHaveBeenCalledOnce();
});

it("lets the server buffer the refresh request before reloading", async () => {
  let accept: (() => void) | undefined;
  const report = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        accept = resolve;
      }),
  );
  const reload = vi.fn();
  const usage = createWebBuildUpdateUsage(reload);
  const pending = usage.refresh("build-b", report);
  await Promise.resolve();
  expect(reload).not.toHaveBeenCalled();
  accept?.();
  await pending;
  expect(reload).toHaveBeenCalledOnce();
});

it("reloads within 200ms if reporting hangs, and ignores repeated refresh clicks", async () => {
  vi.useFakeTimers();
  const report = vi.fn(() => new Promise<void>(() => {}));
  const reload = vi.fn();
  const usage = createWebBuildUpdateUsage(reload);
  const pending = usage.refresh("build-b", report);
  await usage.refresh("build-b", report);
  await vi.advanceTimersByTimeAsync(199);
  expect(reload).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(reload).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("reporting failures do not prevent refresh or escape as unhandled rejections", async () => {
  const report = vi.fn(() => {
    throw new Error("Synthetic telemetry failure");
  });
  const reload = vi.fn();
  const usage = createWebBuildUpdateUsage(reload);
  usage.noticeShown("build-b", report);
  await usage.refresh("build-b", report);
  expect(reload).toHaveBeenCalledOnce();
});

it("requires both an onscreen notice and a visible document, and stops observing on cleanup", () => {
  let notify: IntersectionObserverCallback = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const shown = vi.fn();
  const cleanup = observeWebBuildUpdateNotice(document.createElement("button"), shown);
  const intersection = (isIntersecting: boolean) =>
    notify([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
  intersection(true);
  expect(shown).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(shown).toHaveBeenCalledOnce();
  shown.mockClear();
  intersection(false);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(shown).not.toHaveBeenCalled();
  cleanup();
  expect(disconnect).toHaveBeenCalledOnce();
  document.dispatchEvent(new Event("visibilitychange"));
  expect(shown).not.toHaveBeenCalled();
});
