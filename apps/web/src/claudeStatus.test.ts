import { describe, expect, it } from "vite-plus/test";

import { resolveClaudeStatusNotice } from "./claudeStatus";

function statusSummary(input?: {
  readonly indicator?: string;
  readonly description?: string;
  readonly components?: ReadonlyArray<{
    readonly name: string;
    readonly status: string;
    readonly showcase?: boolean;
  }>;
  readonly incidents?: ReadonlyArray<{
    readonly components?: ReadonlyArray<{
      readonly name: string;
      readonly showcase?: boolean;
    }>;
    readonly impact: string;
    readonly name: string;
    readonly status: string;
  }>;
}) {
  return {
    status: {
      indicator: input?.indicator ?? "none",
      description: input?.description ?? "All Systems Operational",
    },
    components: input?.components ?? [
      { name: "Claude API (api.anthropic.com)", status: "operational", showcase: true },
      { name: "Claude Code", status: "operational", showcase: true },
    ],
    incidents: input?.incidents ?? [],
  };
}

describe("Claude status notice", () => {
  it("stays hidden while Claude reports all systems operational", () => {
    expect(resolveClaudeStatusNotice(statusSummary())).toBeNull();
  });

  it("lists affected public services and derives the strongest tone", () => {
    expect(
      resolveClaudeStatusNotice(
        statusSummary({
          indicator: "major",
          description: "Partial System Outage",
          components: [
            { name: "claude.ai", status: "operational", showcase: true },
            { name: "Claude API (api.anthropic.com)", status: "major_outage", showcase: true },
            { name: "Claude Code", status: "degraded_performance", showcase: true },
            { name: "Internal rollup", status: "major_outage", showcase: false },
          ],
        }),
      ),
    ).toEqual({
      activeIncidents: [],
      affectedComponents: [
        {
          name: "Claude API (api.anthropic.com)",
          status: "major_outage",
          statusLabel: "Major outage",
        },
        {
          name: "Claude Code",
          status: "degraded_performance",
          statusLabel: "Degraded performance",
        },
      ],
      description: "Partial System Outage",
      label: "Claude Outage: Claude API (api.anthropic.com), Claude Code",
      tone: "error",
    });
  });

  it("shows an unresolved incident even when the aggregate status is operational", () => {
    expect(
      resolveClaudeStatusNotice(
        statusSummary({
          incidents: [
            {
              components: [
                { name: "claude.ai", showcase: true },
                { name: "Claude API (api.anthropic.com)", showcase: true },
                { name: "Claude Code", showcase: true },
                { name: "Claude Cowork", showcase: true },
                { name: "Internal rollup", showcase: false },
              ],
              impact: "minor",
              name: "Degraded performance for Claude Opus 5, Claude Sonnet 5",
              status: "monitoring",
            },
          ],
        }),
      ),
    ).toEqual({
      activeIncidents: [
        {
          affectedComponents: [
            "claude.ai",
            "Claude API (api.anthropic.com)",
            "Claude Code",
            "Claude Cowork",
          ],
          impact: "minor",
          name: "Degraded performance for Claude Opus 5, Claude Sonnet 5",
          status: "monitoring",
          statusLabel: "Monitoring",
        },
      ],
      affectedComponents: [],
      description: "1 active incident",
      label: "Claude Incident: Degraded performance for Claude Opus 5, Claude Sonnet 5",
      tone: "warning",
    });
  });

  it("ignores malformed responses", () => {
    expect(resolveClaudeStatusNotice({ status: "down" })).toBeNull();
  });
});
