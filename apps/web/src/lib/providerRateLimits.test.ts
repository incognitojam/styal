import { describe, expect, it } from "vite-plus/test";

import { deriveProviderRateLimitRows } from "./providerRateLimits";

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);
const at = (ms: number) => new Date(NOW + ms).toISOString();
const CHECKED_AT = "2026-01-01T00:00:00.000Z";

describe("deriveProviderRateLimitRows", () => {
  it("returns nothing when the provider reported no limits", () => {
    expect(deriveProviderRateLimitRows(undefined, NOW)).toEqual([]);
  });

  it("uses the provider's window names and formats hours with minutes", () => {
    const rows = deriveProviderRateLimitRows(
      {
        checkedAt: CHECKED_AT,
        windows: [
          {
            id: "primary",
            kind: "session",
            label: "Session",
            usedPercent: 89,
            resetsAt: at(110 * 60_000),
            windowDurationMins: 300,
          },
          {
            id: "secondary",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 74,
            resetsAt: at(6 * 86_400_000),
            windowDurationMins: 10_080,
          },
        ],
      },
      NOW,
    );
    expect(rows).toEqual([
      { id: "primary", name: "Session", resetText: "Resets in 1 hr 50 min", usedPercent: 89 },
      { id: "secondary", name: "Weekly", resetText: "Resets in 6 days", usedPercent: 74 },
    ]);
  });

  it("keeps a window that reported no reset time", () => {
    const rows = deriveProviderRateLimitRows(
      {
        checkedAt: CHECKED_AT,
        windows: [
          { id: "seven_day_fable", kind: "weekly", label: "Weekly · Fable", usedPercent: 40 },
        ],
      },
      NOW,
    );
    expect(rows).toEqual([
      { id: "seven_day_fable", name: "Weekly · Fable", resetText: null, usedPercent: 40 },
    ]);
  });

  it("keeps a just-passed reset within the skew grace period", () => {
    const rows = deriveProviderRateLimitRows(
      {
        checkedAt: CHECKED_AT,
        windows: [
          {
            id: "primary",
            kind: "session",
            label: "Session",
            usedPercent: 89,
            resetsAt: at(-30_000),
          },
        ],
      },
      NOW,
    );
    expect(rows).toEqual([
      { id: "primary", name: "Session", resetText: "Resets soon", usedPercent: 89 },
    ]);
  });

  it("drops a window whose reset has genuinely passed", () => {
    // The snapshot predates the rollover, so its 89% describes a window that
    // no longer exists; showing it would be a stale label.
    const rows = deriveProviderRateLimitRows(
      {
        checkedAt: CHECKED_AT,
        windows: [
          {
            id: "primary",
            kind: "session",
            label: "Session",
            usedPercent: 89,
            resetsAt: at(-10 * 60_000),
          },
          {
            id: "secondary",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 74,
            resetsAt: at(86_400_000),
          },
        ],
      },
      NOW,
    );
    expect(rows.map((row) => row.id)).toEqual(["secondary"]);
  });
});
