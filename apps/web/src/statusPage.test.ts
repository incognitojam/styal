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

/** Every relevance case below ignores Widgets, a surface this service does not drive. */
const notice = (input: ReturnType<typeof summary>) =>
  resolveStatusPageNotice(input, "Example", { ignoredComponents: ["Widgets"] });

describe("status page component naming", () => {
  it("drops the vendor word only where what follows is generic", () => {
    const label = (name: string) =>
      resolveStatusPageNotice(summary([[name, "degraded_performance"]]), "Claude")?.label;

    // Generic: the icon already says whose API it is, and the hostname goes too.
    expect(label("Claude API (api.anthropic.com)")).toBe("Outage: API");
    expect(label("Claude Console (platform.claude.com)")).toBe("Outage: Console");
    // Product names keep the vendor word; "Code" alone is not a product.
    expect(label("Claude Code")).toBe("Outage: Claude Code");
    expect(label("Claude Cowork")).toBe("Outage: Claude Cowork");
    expect(label("claude.ai")).toBe("Outage: claude.ai");
  });
});

describe("status page relevance", () => {
  it("stays hidden when every disruption is ignored", () => {
    expect(notice(summary([["Widgets", "degraded_performance"]]))).toBeNull();
    expect(notice(summary([], [["Degraded performance on Widgets", ["Widgets"]]]))).toBeNull();
    // The hostname a status page appends for disambiguation does not defeat the match.
    expect(notice(summary([["Widgets (widgets.example.com)", "major_outage"]]))).toBeNull();
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
      label: "Outage: Engine",
      tone: "warning",
    });
  });

  it("narrows a mixed incident to the components that reach us", () => {
    expect(notice(summary([], [["Elevated error rates", ["Widgets", "Engine"]]]))).toMatchObject({
      activeIncidents: [{ affectedComponents: ["Engine"] }],
      label: "Incident: Engine",
    });
  });

  it("keeps an incident naming no component, which is unattributable rather than irrelevant", () => {
    expect(
      notice(summary([["Widgets", "major_outage"]], [["Elevated error rates", []]])),
    ).toMatchObject({ label: "1 active incident" });
  });

  it("keeps trusting the aggregate indicator when nothing was ignored", () => {
    expect(notice(summary([]))).toMatchObject({ label: "Outage: service disruption" });
  });
});
