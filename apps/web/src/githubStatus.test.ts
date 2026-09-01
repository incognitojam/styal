import { describe, expect, it } from "vite-plus/test";

import { hasGitHubProject, resolveGitHubStatusNotice } from "./githubStatus";

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
  it("is relevant only when at least one project uses GitHub", () => {
    expect(hasGitHubProject([])).toBe(false);
    expect(
      hasGitHubProject([
        {},
        { repositoryIdentity: null },
        { repositoryIdentity: { provider: "gitlab" } },
      ]),
    ).toBe(false);
    expect(
      hasGitHubProject([
        { repositoryIdentity: { provider: "gitlab" } },
        { repositoryIdentity: { provider: "github" } },
      ]),
    ).toBe(true);
  });

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
      activeIncidents: [],
      affectedComponents: [
        { name: "Actions", status: "major_outage", statusLabel: "Major outage" },
        {
          name: "Pages",
          status: "degraded_performance",
          statusLabel: "Degraded performance",
        },
      ],
      description: "Partial System Outage",
      accessibleLabel: "GitHub Outage: Actions, Pages",
      label: "Outage: Actions, Pages",
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

    expect(notice?.label).toBe("Outage: 3 services");
    expect(notice?.accessibleLabel).toBe("GitHub Outage: 3 services");
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
      activeIncidents: [],
      affectedComponents: [],
      description: "Minor Service Outage",
      accessibleLabel: "GitHub Outage: service disruption",
      label: "Outage: service disruption",
      tone: "warning",
    });
  });

  it("ignores Copilot while keeping the source control services", () => {
    const copilot = [
      { name: "Copilot", status: "partial_outage", showcase: true },
      { name: "Copilot AI Model Providers", status: "degraded_performance", showcase: true },
    ];
    const label = (components: typeof copilot) =>
      resolveGitHubStatusNotice(statusSummary({ indicator: "major", components }))?.label ?? null;

    expect(label(copilot)).toBeNull();
    expect(
      label([
        ...copilot,
        { name: "Pull Requests", status: "degraded_performance", showcase: true },
      ]),
    ).toBe("Outage: Pull Requests");
  });

  it("ignores malformed responses", () => {
    expect(resolveGitHubStatusNotice({ status: "down" })).toBeNull();
  });
});
