import { afterEach, expect, it, vi } from "vite-plus/test";

import { createWebBuildUpdateUsage } from "./webBuildUpdateUsage";

afterEach(() => {
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
