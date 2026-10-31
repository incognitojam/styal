import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { msUntilRelativeTimeChange, relativeTime } from "./time";

describe("relativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses days, months, and years as the timestamp gets older", () => {
    expect(relativeTime("2026-03-09T12:00:00.000Z")).toBe("29d");
    expect(relativeTime("2026-03-08T12:00:00.000Z")).toBe("1mo");
    expect(relativeTime("2025-04-13T12:00:00.000Z")).toBe("11mo");
    expect(relativeTime("2025-04-12T12:00:00.000Z")).toBe("1y");
  });

  it("measures from the clock reading it is given", () => {
    const updatedAt = "2026-04-07T11:59:00.000Z";
    expect(relativeTime(updatedAt)).toBe("1m");
    expect(relativeTime(updatedAt, Date.parse("2026-04-07T12:59:00.000Z"))).toBe("1h");
  });
});

const at = "2026-10-19T12:00:00.000Z";
const timestamp = Date.parse(at);

describe("relative time", () => {
  it.each([
    [59_999, "<1m", "1m"],
    [119_999, "1m", "2m"],
    [3_599_999, "59m", "1h"],
    [7_199_999, "1h", "2h"],
    [86_399_999, "23h", "1d"],
    [172_799_999, "1d", "2d"],
  ] as const)("updates at the next boundary after %i ms", (elapsed, before, after) => {
    const nowMs = timestamp + elapsed;
    expect(relativeTime(at, nowMs)).toBe(before);
    expect(msUntilRelativeTimeChange(at, nowMs)).toBe(1);
    expect(relativeTime(at, nowMs + 1)).toBe(after);
  });

  it.each([
    [0, 60_000],
    [60_000, 60_000],
    [3_600_000, 3_600_000],
    [86_400_000, 86_400_000],
  ])("waits a full label interval at %i ms", (elapsed, delay) => {
    expect(msUntilRelativeTimeChange(at, timestamp + elapsed)).toBe(delay);
  });

  it("keeps invalid timestamps static", () => {
    expect(relativeTime("invalid", timestamp)).toBe("<1m");
    expect(msUntilRelativeTimeChange("invalid", timestamp)).toBeNull();
  });

  it("waits until a future timestamp is a minute old, with bounded timers", () => {
    expect(relativeTime(at, timestamp - 30_000)).toBe("<1m");
    expect(msUntilRelativeTimeChange(at, timestamp - 30_000)).toBe(90_000);
    expect(msUntilRelativeTimeChange(at, timestamp - 30 * 86_400_000)).toBe(86_400_000);
  });
});
