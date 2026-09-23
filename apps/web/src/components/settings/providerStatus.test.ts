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

  it("formats each window's usage and reset", () => {
    const lines = getProviderRateLimitLines(
      {
        checkedAt: "2026-01-01T00:00:00.000Z",
        windows: [
          {
            id: "primary",
            kind: "session",
            label: "Session",
            usedPercent: 23,
            resetsAt: new Date(NOW + 3 * 60 * 60 * 1000).toISOString(),
            windowDurationMins: 300,
          },
          {
            id: "secondary",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 6,
            resetsAt: new Date(NOW + 6 * 24 * 60 * 60 * 1000).toISOString(),
            windowDurationMins: 10_080,
          },
          { id: "seven_day_fable", kind: "weekly", label: "Weekly · Fable", usedPercent: 40 },
        ],
      },
      NOW,
    );
    expect(lines).toEqual([
      { id: "primary", text: "Session · 23% used · Resets in 3 hr" },
      { id: "secondary", text: "Weekly · 6% used · Resets in 6 days" },
      { id: "seven_day_fable", text: "Weekly · Fable · 40% used" },
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
