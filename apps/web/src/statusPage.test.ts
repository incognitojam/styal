import { describe, expect, it } from "vite-plus/test";

import { resolveStatusPageNotice } from "./statusPage";

function summary(
  components: ReadonlyArray<readonly [name: string, status: string]>,
  incidents: ReadonlyArray<readonly [name: string, scope: ReadonlyArray<string>]> = [],
  indicator = "minor",
) {
  return {
    status: { indicator, description: "Partially Degraded Service" },
    components: components.map(([name, status]) => ({ name, status })),
    incidents: incidents.map(([name, scope]) => ({
      components: scope.map((component) => ({ name: component })),
      impact: "minor",
      name,
      status: "investigating",
    })),
  };
}

/** Every relevance case below depends on Engine alone, so Widgets is a surface it does not drive. */
const notice = (input: ReturnType<typeof summary>) =>
  resolveStatusPageNotice(input, "Example", { relevantComponents: ["Engine"] });
const engineUp = ["Engine", "operational"] as const;

describe("status page component naming", () => {
  it("drops the vendor word only where what follows is generic", () => {
    const label = (name: string) =>
      resolveStatusPageNotice(summary([[name, "degraded_performance"]]), "Claude")?.label;

    // Generic: the icon already says whose API it is, and the hostname goes too.
    expect(label("Claude API (api.anthropic.com)")).toBe("Degraded: API");
    expect(label("Claude Console (platform.claude.com)")).toBe("Degraded: Console");
    // Product names keep the vendor word; "Code" alone is not a product.
    expect(label("Claude Code")).toBe("Degraded: Claude Code");
    expect(label("Claude Cowork")).toBe("Degraded: Claude Cowork");
    expect(label("claude.ai")).toBe("Degraded: claude.ai");
  });

  it("names the worst disruption among the affected components", () => {
    const label = (components: ReadonlyArray<readonly [string, string]>) =>
      resolveStatusPageNotice(summary(components), "Example")?.label;

    expect(
      label([
        ["Engine", "degraded_performance"],
        ["Gearbox", "partial_outage"],
      ]),
    ).toBe("Outage: Engine, Gearbox");
    expect(
      label([
        ["Engine", "under_maintenance"],
        ["Gearbox", "degraded_performance"],
      ]),
    ).toBe("Degraded: Engine, Gearbox");
    expect(label([["Engine", "under_maintenance"]])).toBe("Maintenance: Engine");
  });
});

describe("status page relevance", () => {
  it("stays hidden when no disruption touches a relevant component", () => {
    expect(notice(summary([engineUp, ["Widgets", "degraded_performance"]]))).toBeNull();
    expect(
      notice(summary([engineUp], [["Degraded performance on Widgets", ["Widgets"]]])),
    ).toBeNull();
  });

  it("matches a relevant component despite the hostname a status page appends", () => {
    expect(notice(summary([["Engine (engine.example.com)", "major_outage"]]))).toMatchObject({
      label: "Outage: Engine",
    });
  });

  it("counts every component when the page lists none of the relevant names", () => {
    expect(notice(summary([["Widgets", "degraded_performance"]]))).toMatchObject({
      label: "Degraded: Widgets",
    });
  });

  it("takes severity from what survived rather than the aggregate indicator", () => {
    expect(
      notice(
        summary(
          [
            ["Widgets", "major_outage"],
            ["Engine", "degraded_performance"],
          ],
          [],
          "major",
        ),
      ),
    ).toMatchObject({
      affectedComponents: [{ name: "Engine", status: "degraded_performance" }],
      label: "Degraded: Engine",
      tone: "warning",
    });
  });

  it("narrows a mixed incident to the components that reach us", () => {
    expect(
      notice(summary([engineUp], [["Elevated error rates", ["Widgets", "Engine"]]])),
    ).toMatchObject({
      activeIncidents: [{ affectedComponents: ["Engine"] }],
      label: "Incident: Engine",
    });
  });

  it("keeps an incident naming no component, which is unattributable rather than irrelevant", () => {
    expect(
      notice(summary([engineUp, ["Widgets", "major_outage"]], [["Elevated error rates", []]])),
    ).toMatchObject({ label: "1 active incident" });
  });

  it("keeps trusting the aggregate indicator when nothing was ignored", () => {
    expect(notice(summary([]))).toMatchObject({ label: "Outage: service disruption" });
  });
});
