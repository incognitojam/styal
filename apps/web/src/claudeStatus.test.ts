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
      accessibleLabel: "Claude Outage: API, Claude Code",
      label: "Outage: API, Claude Code",
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
          affectedComponents: ["Claude API (api.anthropic.com)", "Claude Code"],
          impact: "minor",
          name: "Degraded performance for Claude Opus 5, Claude Sonnet 5",
          status: "monitoring",
          statusLabel: "Monitoring",
        },
      ],
      affectedComponents: [],
      description: "1 active incident",
      accessibleLabel: "Claude Incident: API, Claude Code",
      label: "Incident: API, Claude Code",
      tone: "warning",
    });
  });

  it("ignores the surfaces Claude Code never calls, and only those", () => {
    const elsewhere = [
      { name: "claude.ai", status: "degraded_performance", showcase: true },
      { name: "Claude Console (platform.claude.com)", status: "major_outage", showcase: true },
      { name: "Claude Cowork", status: "partial_outage", showcase: true },
      { name: "Claude for Government", status: "major_outage", showcase: true },
    ];
    const label = (components: typeof elsewhere) =>
      resolveClaudeStatusNotice(statusSummary({ indicator: "major", components }))?.label ?? null;

    expect(label(elsewhere)).toBeNull();
    expect(
      label([
        ...elsewhere,
        { name: "Claude API (api.anthropic.com)", status: "degraded_performance", showcase: true },
      ]),
    ).toBe("Outage: API");
  });

  it("falls back to the incident count when a single incident names no service", () => {
    const notice = resolveClaudeStatusNotice(
      statusSummary({
        incidents: [
          {
            components: [{ name: "Internal rollup", showcase: false }],
            impact: "minor",
            name: "Elevated error rates",
            status: "investigating",
          },
        ],
      }),
    );

    expect(notice?.label).toBe("1 active incident");
    expect(notice?.accessibleLabel).toBe("Claude: 1 active incident");
  });

  it("counts concurrent incidents rather than naming their overlapping scopes", () => {
    const notice = resolveClaudeStatusNotice(
      statusSummary({
        incidents: [
          {
            components: [{ name: "Claude Code", showcase: true }],
            impact: "minor",
            name: "Elevated error rates",
            status: "investigating",
          },
          {
            components: [{ name: "Claude Code", showcase: true }],
            impact: "minor",
            name: "Degraded performance for Claude Opus 5",
            status: "monitoring",
          },
        ],
      }),
    );

    expect(notice?.label).toBe("2 active incidents");
    expect(notice?.accessibleLabel).toBe("Claude: 2 active incidents");
  });

  it("ignores malformed responses", () => {
    expect(resolveClaudeStatusNotice({ status: "down" })).toBeNull();
  });
});
