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
            { name: "Codex API", status: "major_outage" },
            { name: "ChatGPT", status: "degraded_performance" },
          ],
        }),
      ),
    ).toEqual({
      activeIncidents: [],
      affectedComponents: [
        { name: "Codex API", status: "major_outage", statusLabel: "Major outage" },
        {
          name: "ChatGPT",
          status: "degraded_performance",
          statusLabel: "Degraded performance",
        },
      ],
      description: "Partial System Outage",
      accessibleLabel: "OpenAI Outage: Codex API, ChatGPT",
      label: "Outage: Codex API, ChatGPT",
      tone: "error",
    });
  });

  it("shows unresolved incidents with their affected services", () => {
    expect(
      resolveOpenAIStatusNotice(
        statusSummary({
          incidents: [
            {
              components: [{ name: "Codex API" }],
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
          affectedComponents: ["Codex API"],
          impact: "minor",
          name: "Elevated errors in Codex",
          status: "monitoring",
          statusLabel: "Monitoring",
        },
      ],
      affectedComponents: [],
      description: "1 active incident",
      accessibleLabel: "OpenAI Incident: Codex API",
      label: "Incident: Codex API",
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
      accessibleLabel: "OpenAI Outage: Codex API, CLI",
      label: "Outage: Codex API, CLI",
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
      accessibleLabel: "OpenAI Outage: Login",
      label: "Outage: Login",
      tone: "error",
    });
  });

  it("ignores consumer surfaces while keeping the Responses API every Codex turn drives", () => {
    const consumer = [
      { name: "Sora", status: "major_outage" },
      { name: "Voice mode", status: "degraded_performance" },
    ];
    const notice = (components: typeof consumer) =>
      resolveOpenAIStatusNotice(
        statusSummary({
          indicator: "major",
          components,
          // OpenAI files incidents without naming a component, so the component
          // list is the only thing relevance can act on here.
          incidents: [{ impact: "minor", name: "Elevated latency", status: "identified" }],
        }),
      );

    expect(notice(consumer)?.label).toBe("1 active incident");
    expect(
      notice([...consumer, { name: "Responses", status: "degraded_performance" }])?.label,
    ).toBe("Outage: Responses");
  });

  it("narrows a broad outage to the services a Codex turn uses", () => {
    const degraded = [
      "Realtime",
      "Search",
      "Connectors/Apps",
      "File uploads",
      "CLI",
      "Conversations",
      "Image Generation",
      "Batch",
      "Images",
      "Chat Completions",
      "Embeddings",
      "Responses",
      "Moderations",
      "Files",
      "Login",
      "Agents",
      "Codex Web",
      "Codex API",
      "VS Code extension",
      "Codex in ChatGPT Desktop",
    ].map((name) => ({ name, status: "degraded_performance" }));
    expect(
      resolveOpenAIStatusNotice(
        statusSummary({ indicator: "minor", description: "Partial System Degradation" }),
        { components: degraded },
      )?.affectedComponents.map((component) => component.name),
    ).toEqual(["CLI", "Responses", "Login", "Codex API"]);
  });

  it("ignores Space degradation while retaining a concurrent Responses incident", () => {
    const components = [{ name: "Space", status: "degraded_performance" }];
    expect(resolveOpenAIStatusNotice(statusSummary({ indicator: "minor", components }))).toBeNull();

    expect(
      resolveOpenAIStatusNotice(
        statusSummary({
          indicator: "minor",
          components: [...components, { name: "Responses", status: "degraded_performance" }],
          incidents: [
            {
              components: [{ name: "Space" }, { name: "Responses" }],
              impact: "minor",
              name: "Elevated latency for some API requests",
              status: "identified",
            },
          ],
        }),
      ),
    ).toMatchObject({
      label: "Outage: Responses",
      affectedComponents: [{ name: "Responses" }],
      activeIncidents: [
        { affectedComponents: ["Responses"], name: "Elevated latency for some API requests" },
      ],
    });
  });

  describe.each(["ChatGPT Work", "ChatGPT Space Pages"])("%s incidents", (surface) => {
    it.each([undefined, []])("ignores a componentless incident (%j)", (components) => {
      expect(
        resolveOpenAIStatusNotice(
          statusSummary({
            indicator: "minor",
            incidents: [
              {
                ...(components === undefined ? {} : { components }),
                impact: "minor",
                name: `Elevated errors in ${surface}`,
                status: "monitoring",
              },
            ],
          }),
        ),
      ).toBeNull();
    });

    it("ignores an outage confined to the component", () => {
      expect(
        resolveOpenAIStatusNotice(
          statusSummary({
            indicator: "minor",
            components: [{ name: surface, status: "degraded_performance" }],
            incidents: [
              {
                components: [{ name: surface }],
                impact: "minor",
                name: `Elevated errors in ${surface}`,
                status: "monitoring",
              },
            ],
          }),
        ),
      ).toBeNull();
    });

    it("keeps an incident whose components include Codex", () => {
      expect(
        resolveOpenAIStatusNotice(
          statusSummary({
            incidents: [
              {
                components: [{ name: surface }, { name: "Codex API" }],
                impact: "minor",
                name: `Elevated errors in ${surface}`,
                status: "monitoring",
              },
            ],
          }),
        ),
      ).toMatchObject({ label: "Incident: Codex API" });
    });

    it("keeps concurrent API outages and broader componentless incidents", () => {
      const broaderIncident = {
        impact: "minor",
        name: `Elevated errors in ${surface} and Codex`,
        status: "investigating",
      };
      expect(
        resolveOpenAIStatusNotice(
          statusSummary({
            indicator: "major",
            components: [{ name: "Responses", status: "partial_outage" }],
            incidents: [
              { impact: "minor", name: `Elevated errors in ${surface}`, status: "monitoring" },
              broaderIncident,
            ],
          }),
        ),
      ).toMatchObject({
        label: "Outage: Responses",
        tone: "error",
        activeIncidents: [broaderIncident],
      });
    });
  });

  it.each([
    "SSO sign-in and SCIM provisioning issues",
    "Overbilling for OpenAI-hosted containers in the Agent API",
    "Delayed support responses",
    "Support available via email",
  ])("ignores the unrelated componentless incident %j", (name) => {
    expect(
      resolveOpenAIStatusNotice(
        statusSummary({
          indicator: "minor",
          incidents: [{ impact: "none", name, status: "investigating" }],
        }),
      ),
    ).toBeNull();
  });

  it("ignores malformed responses", () => {
    expect(resolveOpenAIStatusNotice({ status: "down" })).toBeNull();
  });
});
