import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { relativeTime } from "./time";

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
});
