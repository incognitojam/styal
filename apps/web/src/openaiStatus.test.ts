import { describe, expect, it } from "vite-plus/test";

import { resolveOpenAIStatusNotice } from "./openaiStatus";

function statusSummary(input?: {
  readonly indicator?: string;
  readonly description?: string;
  readonly components?: ReadonlyArray<{
    readonly name: string;
    readonly status: string;
  }>;
  readonly incidents?: ReadonlyArray<{
    readonly components?: ReadonlyArray<{
      readonly name: string;
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
      { name: "Codex Web", status: "operational" },
      { name: "Responses", status: "operational" },
    ],
    incidents: input?.incidents ?? [],
  };
}

describe("OpenAI status notice", () => {
  it("stays hidden while OpenAI reports all systems operational", () => {
    expect(resolveOpenAIStatusNotice(statusSummary())).toBeNull();
  });

  it("lists affected OpenAI and Codex services", () => {
    expect(
      resolveOpenAIStatusNotice(
        statusSummary({
          indicator: "major",
          description: "Partial System Outage",
          components: [
            { name: "Responses", status: "operational" },
            { name: "Codex Web", status: "major_outage" },
            { name: "ChatGPT", status: "degraded_performance" },
          ],
        }),
      ),
    ).toEqual({
      activeIncidents: [],
      affectedComponents: [
        { name: "Codex Web", status: "major_outage", statusLabel: "Major outage" },
        {
          name: "ChatGPT",
          status: "degraded_performance",
          statusLabel: "Degraded performance",
        },
      ],
      description: "Partial System Outage",
      label: "OpenAI Outage: Codex Web, ChatGPT",
      tone: "error",
    });
  });

  it("shows unresolved incidents with their affected services", () => {
    expect(
      resolveOpenAIStatusNotice(
        statusSummary({
          incidents: [
            {
              components: [{ name: "Codex Web" }],
              impact: "minor",
              name: "Elevated errors in Codex",
              status: "monitoring",
            },
          ],
        }),
      ),
    ).toEqual({
      activeIncidents: [
        {
          affectedComponents: ["Codex Web"],
          impact: "minor",
          name: "Elevated errors in Codex",
          status: "monitoring",
          statusLabel: "Monitoring",
        },
      ],
      affectedComponents: [],
      description: "1 active incident",
      label: "OpenAI Incident: Elevated errors in Codex",
      tone: "warning",
    });
  });

  it("uses the complete component listing for Codex API and CLI outages", () => {
    expect(
      resolveOpenAIStatusNotice(
        statusSummary({
          components: [{ name: "Codex Web", status: "operational" }],
        }),
        {
          components: [
            { name: "Codex Web", status: "operational" },
            { name: "Codex API", status: "partial_outage" },
            { name: "CLI", status: "degraded_performance" },
          ],
        },
      ),
    ).toMatchObject({
      affectedComponents: [
        { name: "Codex API", status: "partial_outage" },
        { name: "CLI", status: "degraded_performance" },
      ],
      label: "OpenAI Outage: Codex API, CLI",
      tone: "error",
    });
  });

  it("deduplicates same-named components using the strongest status", () => {
    expect(
      resolveOpenAIStatusNotice(statusSummary(), {
        components: [
          { name: "Login", status: "degraded_performance" },
          { name: "Login", status: "major_outage" },
        ],
      }),
    ).toMatchObject({
      affectedComponents: [{ name: "Login", status: "major_outage" }],
      label: "OpenAI Outage: Login",
      tone: "error",
    });
  });

  it("ignores malformed responses", () => {
    expect(resolveOpenAIStatusNotice({ status: "down" })).toBeNull();
  });
});
