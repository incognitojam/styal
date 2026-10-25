import { afterEach, expect, it, vi } from "vite-plus/test";
import { watchSimulatorRestart } from "./simulatorStreamRecovery.ts";

afterEach(() => vi.useRealTimers());

it("refreshes a passive peer until a slow restart finishes and then stops", async () => {
  vi.useFakeTimers();
  let ownerRevision = "before-restart";
  let viewerRevision = ownerRevision;
  const read = vi.fn(async () => (viewerRevision = ownerRevision));
  const stop = watchSimulatorRestart(viewerRevision, read);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(viewerRevision).toBe("before-restart");
  ownerRevision = "after-restart";
  await vi.advanceTimersByTimeAsync(10_000);
  expect(viewerRevision).toBe(ownerRevision);
  const calls = read.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).toHaveBeenCalledTimes(calls);
  stop();
});

it("does not overlap requests and cancels recovery when the viewer closes", async () => {
  vi.useFakeTimers();
  let resolve!: (value: string) => void;
  const read = vi.fn(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  const stop = watchSimulatorRestart("old", read);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).toHaveBeenCalledTimes(1);
  stop();
  resolve("old");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("survives unavailable inventory and bounds recovery to the profile deadline", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => {
    throw new Error("peer restarting");
  });
  const stop = watchSimulatorRestart(undefined, read);
  await vi.advanceTimersByTimeAsync(31 * 60_000);
  expect(read).toHaveBeenCalledTimes(180);
  expect(vi.getTimerCount()).toBe(0);
  stop();
});
