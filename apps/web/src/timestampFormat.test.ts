import { describe, expect, it } from "vite-plus/test";

import { formatRelativeTime } from "./timestampFormat";

describe("relative time boundaries", () => {
  const nowMs = Date.parse("2026-04-07T12:00:00.000Z");

  it("uses months and years for older timestamps", () => {
    expect(formatRelativeTime("2026-03-08T12:00:00.000Z", nowMs)).toEqual({
      value: "1mo",
      suffix: "ago",
    });
    expect(formatRelativeTime("2025-04-13T12:00:00.000Z", nowMs)).toEqual({
      value: "11mo",
      suffix: "ago",
    });
    expect(formatRelativeTime("2025-04-12T12:00:00.000Z", nowMs)).toEqual({
      value: "1y",
      suffix: "ago",
    });
  });
});
