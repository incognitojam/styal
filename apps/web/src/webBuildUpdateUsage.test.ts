import { afterEach, expect, it, vi } from "vite-plus/test";

import { createWebBuildUpdateUsage } from "./webBuildUpdateUsage";

afterEach(() => {
  vi.useRealTimers();
});

it("counts each build exposure once and keeps its refresh on the original environment", async () => {
  const firstEnvironment = vi.fn(async () => true);
  const secondEnvironment = vi.fn(async () => true);
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
  const report = vi.fn(() => new Promise<boolean>(() => {}));
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
});

it("allows another refresh when the page survives the reload", async () => {
  vi.useFakeTimers();
  const report = vi.fn(async () => true);
  const reload = vi.fn();
  const usage = createWebBuildUpdateUsage(reload);
  await usage.refresh("build-b", report);
  await usage.refresh("build-b", report);
  expect(reload).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2_000);
  await usage.refresh("build-b", report);
  expect(reload).toHaveBeenCalledTimes(2);
});

it("counts an exposure only once the server receives it", async () => {
  let state: "unsupported" | "offline" | "online" = "unsupported";
  const report = vi.fn((_action: "notice_shown" | "refresh_requested") =>
    state === "unsupported" ? undefined : Promise.resolve(state === "online"),
  );
  const usage = createWebBuildUpdateUsage(vi.fn());
  usage.noticeShown("build-b", report);
  state = "offline";
  usage.noticeShown("build-b", report);
  // A sighting while the offline attempt is in flight does not send a duplicate.
  usage.noticeShown("build-b", report);
  await Promise.resolve();
  state = "online";
  usage.noticeShown("build-b", report);
  await Promise.resolve();
  usage.noticeShown("build-b", report);
  expect(report).toHaveBeenCalledTimes(3);
});
