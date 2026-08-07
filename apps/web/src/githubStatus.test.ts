import { describe, expect, it } from "vite-plus/test";

import { resolveGitHubStatusNotice } from "./githubStatus";

function statusSummary(input?: {
  readonly indicator?: string;
  readonly description?: string;
  readonly components?: ReadonlyArray<{
    readonly name: string;
    readonly status: string;
    readonly showcase?: boolean;
  }>;
}) {
  return {
    status: {
      indicator: input?.indicator ?? "none",
      description: input?.description ?? "All Systems Operational",
    },
    components: input?.components ?? [
      { name: "Git Operations", status: "operational", showcase: true },
      { name: "Actions", status: "operational", showcase: true },
    ],
  };
}

describe("GitHub status notice", () => {
  it("stays hidden while GitHub reports all systems operational", () => {
    expect(resolveGitHubStatusNotice(statusSummary())).toBeNull();
  });

  it("lists affected public services and derives the strongest tone", () => {
    expect(
      resolveGitHubStatusNotice(
        statusSummary({
          indicator: "major",
          description: "Partial System Outage",
          components: [
            { name: "Git Operations", status: "operational", showcase: true },
            { name: "Actions", status: "major_outage", showcase: true },
            { name: "Pages", status: "degraded_performance", showcase: true },
            { name: "Internal rollup", status: "major_outage", showcase: false },
          ],
        }),
      ),
    ).toEqual({
      affectedComponents: [
        { name: "Actions", status: "major_outage", statusLabel: "Major outage" },
        {
          name: "Pages",
          status: "degraded_performance",
          statusLabel: "Degraded performance",
        },
      ],
      description: "Partial System Outage",
      label: "GitHub Outage: Actions, Pages",
      tone: "error",
    });
  });

  it("uses a compact count when several services are affected", () => {
    const notice = resolveGitHubStatusNotice(
      statusSummary({
        indicator: "minor",
        description: "Minor Service Outage",
        components: [
          { name: "API Requests", status: "degraded_performance" },
          { name: "Issues", status: "degraded_performance" },
          { name: "Pull Requests", status: "under_maintenance" },
        ],
      }),
    );

    expect(notice?.label).toBe("GitHub Outage: 3 services affected");
    expect(notice?.tone).toBe("warning");
  });

  it("falls back to the global disruption when no component is named", () => {
    expect(
      resolveGitHubStatusNotice(
        statusSummary({
          indicator: "minor",
          description: "Minor Service Outage",
          components: [],
        }),
      ),
    ).toEqual({
      affectedComponents: [],
      description: "Minor Service Outage",
      label: "GitHub Outage: service disruption",
      tone: "warning",
    });
  });

  it("ignores malformed responses", () => {
    expect(resolveGitHubStatusNotice({ status: "down" })).toBeNull();
  });
});
