import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", label: "ChatGPT" },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

import { getProviderSummary, getProviderRateLimitLines } from "./providerStatus";

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

describe("getProviderSummary", () => {
  it("reports ready providers with unknown authentication as available", () => {
    expect(getProviderSummary({ ...provider, auth: { status: "unknown" } })).toEqual({
      headline: "Available",
      detail: null,
    });
  });

  it("does not hide a provider error behind a previous authenticated state", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "error",
        message: "The provider process failed to start.",
      }),
    ).toEqual({
      headline: "Unavailable",
      detail: "The provider process failed to start.",
    });
  });

  it("does not hide a provider warning behind an authenticated state", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "warning",
        message: "The provider version is unsupported.",
      }),
    ).toEqual({
      headline: "Needs attention",
      detail: "The provider version is unsupported.",
    });
  });

  it("keeps authentication failures actionable when their provider status is error", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Run codex login.",
      }),
    ).toEqual({
      headline: "Not authenticated",
      detail: "Run codex login.",
    });
  });

  it("treats a disabled provider status as disabled even before its enabled flag updates", () => {
    expect(getProviderSummary({ ...provider, status: "disabled" }).headline).toBe("Disabled");
  });
});
