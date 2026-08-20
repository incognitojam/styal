import { describe, expect, it } from "vite-plus/test";

import { getProviderRateLimitLines } from "./providerStatus";

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

describe("getProviderRateLimitLines", () => {
  it("returns nothing when the provider reported no limits", () => {
    expect(getProviderRateLimitLines(undefined, NOW)).toEqual([]);
  });

  it("names windows from their duration and formats usage and reset", () => {
    const lines = getProviderRateLimitLines(
      {
        windows: [
          {
            id: "primary",
            usedPercent: 23,
            resetsAt: (NOW + 3 * 60 * 60 * 1000) / 1000,
            windowMinutes: 300,
          },
          {
            id: "secondary",
            usedPercent: 6,
            resetsAt: (NOW + 6 * 24 * 60 * 60 * 1000) / 1000,
            windowMinutes: 10_080,
          },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      NOW,
    );
    expect(lines).toEqual([
      { id: "primary", text: "5-hour limit · 23% used · Resets in 3 hr" },
      { id: "secondary", text: "Weekly limit · 6% used · Resets in 6 days" },
    ]);
  });

  it("prefers the provider-supplied label and tolerates missing fields", () => {
    const lines = getProviderRateLimitLines(
      {
        windows: [
          { id: "spark:primary", label: "Spark", usedPercent: 40, windowMinutes: 10_080 },
          { id: "five_hour", resetsAt: (NOW + 30 * 60 * 1000) / 1000 },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      NOW,
    );
    expect(lines).toEqual([
      { id: "spark:primary", text: "Spark limit · 40% used" },
      { id: "five_hour", text: "five_hour · Resets in 30 min" },
    ]);
  });
});
