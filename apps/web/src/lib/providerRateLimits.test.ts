import { describe, expect, it } from "vite-plus/test";

import { deriveProviderRateLimitRows } from "./providerRateLimits";

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);
const inSeconds = (ms: number) => (NOW + ms) / 1000;

describe("deriveProviderRateLimitRows", () => {
  it("returns nothing when the provider reported no limits", () => {
    expect(deriveProviderRateLimitRows(undefined, NOW)).toEqual([]);
  });

  it("names windows by duration and formats hours with minutes", () => {
    const rows = deriveProviderRateLimitRows(
      {
        windows: [
          { id: "primary", usedPercent: 89, resetsAt: inSeconds(110 * 60_000), windowMinutes: 300 },
          {
            id: "secondary",
            usedPercent: 74,
            resetsAt: inSeconds(6 * 86_400_000),
            windowMinutes: 10_080,
          },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      NOW,
    );
    expect(rows).toEqual([
      { id: "primary", name: "5-hour limit", resetText: "Resets in 1 hr 50 min", usedPercent: 89 },
      { id: "secondary", name: "Weekly limit", resetText: "Resets in 6 days", usedPercent: 74 },
    ]);
  });

  it("keeps a window that reported a reset but no percentage", () => {
    const rows = deriveProviderRateLimitRows(
      {
        windows: [{ id: "five_hour", resetsAt: inSeconds(45 * 60_000) }],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      NOW,
    );
    expect(rows).toEqual([
      { id: "five_hour", name: "five_hour", resetText: "Resets in 45 min", usedPercent: null },
    ]);
  });

  it("keeps a just-passed reset within the skew grace period", () => {
    const rows = deriveProviderRateLimitRows(
      {
        windows: [
          { id: "primary", usedPercent: 89, resetsAt: inSeconds(-30_000), windowMinutes: 300 },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      NOW,
    );
    expect(rows).toEqual([
      { id: "primary", name: "5-hour limit", resetText: "Resets soon", usedPercent: 89 },
    ]);
  });

  it("drops a window whose reset has genuinely passed", () => {
    // The snapshot predates the rollover, so its 89% describes a window that
    // no longer exists; showing it would be a stale label.
    const rows = deriveProviderRateLimitRows(
      {
        windows: [
          { id: "primary", usedPercent: 89, resetsAt: inSeconds(-10 * 60_000), windowMinutes: 300 },
          {
            id: "secondary",
            usedPercent: 74,
            resetsAt: inSeconds(86_400_000),
            windowMinutes: 10_080,
          },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      NOW,
    );
    expect(rows.map((row) => row.id)).toEqual(["secondary"]);
  });

  it("prefers a provider-supplied label over the derived duration name", () => {
    const rows = deriveProviderRateLimitRows(
      {
        windows: [{ id: "primary", label: "Fable", usedPercent: 93, windowMinutes: 10_080 }],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      NOW,
    );
    expect(rows[0]).toEqual({
      id: "primary",
      name: "Fable limit",
      resetText: null,
      usedPercent: 93,
    });
  });
});
