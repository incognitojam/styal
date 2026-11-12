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

  it("lists affected Codex services and leaves out components it does not name", () => {
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
      ],
      description: "Partial System Outage",
      accessibleLabel: "OpenAI Outage: Codex API",
      label: "Outage: Codex API",
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
          incidents: [{ impact: "minor", name: "Elevated latency", status: "identified" }],
        }),
      );

    expect(notice([...consumer, { name: "Responses", status: "operational" }])).toBeNull();
    expect(
      notice([...consumer, { name: "Responses", status: "degraded_performance" }])?.label,
    ).toBe("Degraded: Responses");
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
    expect(
      resolveOpenAIStatusNotice(
        statusSummary({
          indicator: "minor",
          components: [...components, { name: "Responses", status: "operational" }],
        }),
      ),
    ).toBeNull();

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
      label: "Degraded: Responses",
      affectedComponents: [{ name: "Responses" }],
      activeIncidents: [
        { affectedComponents: ["Responses"], name: "Elevated latency for some API requests" },
      ],
    });
  });

  describe.each([
    ["ChatGPT Work", "Elevated errors in ChatGPT Work"],
    ["ChatGPT Work", "ChatGPT Work and Dots Errors"],
    ["ChatGPT Space Pages", "Elevated errors in ChatGPT Space Pages"],
    ["Compliance API", "Delayed Costs data in the Compliance API"],
    ["dots", "Degraded Performance of Dots on Enterprise"],
  ])("%s incidents", (surface, incidentName) => {
    it.each([undefined, []])("ignores a componentless incident (%j)", (components) => {
      expect(
        resolveOpenAIStatusNotice(
          statusSummary({
            indicator: "minor",
            incidents: [
              {
                ...(components === undefined ? {} : { components }),
                impact: "minor",
                name: incidentName,
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
            components: [
              { name: surface, status: "degraded_performance" },
              { name: "Responses", status: "operational" },
            ],
            incidents: [
              {
                components: [{ name: surface }],
                impact: "minor",
                name: incidentName,
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
                name: incidentName,
                status: "monitoring",
              },
            ],
          }),
        ),
      ).toMatchObject({ label: "Incident: Codex API" });
    });

    it("keeps a componentless incident while a relevant component is disrupted", () => {
      expect(
        resolveOpenAIStatusNotice(
          statusSummary({
            indicator: "major",
            components: [{ name: "Responses", status: "partial_outage" }],
            incidents: [{ impact: "minor", name: incidentName, status: "monitoring" }],
          }),
        ),
      ).toMatchObject({
        label: "Outage: Responses",
        tone: "error",
        activeIncidents: [{ name: incidentName }],
      });
    });
  });

  it.each([
    "Elevated error rates with Brex Cards and U.S. business Mastercards",
    "Elevated error rates in Codex Cloud",
    "Overbilling for OpenAI-hosted containers in the Agent API",
    "Degraded Performance affecting Agents API",
    "SSO sign-in and SCIM provisioning issues",
    "Delayed support responses",
    "Support available via email",
    "New Ad Accounts failing to provision admins",
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

  it.each([
    "Increase in errors on API, Codex and Work Mode",
    "Elevated error rates for Codex and ChatGPT Work",
    "Elevated API errors",
    "Elevated Error Rates on GPT-6 Astra Pro",
    "Investigating unexpected usage limit resets",
  ])(
    "keeps the untagged incident naming Codex, the API, a GPT model, or usage limits %j",
    (name) => {
      expect(
        resolveOpenAIStatusNotice(
          statusSummary({ incidents: [{ impact: "none", name, status: "investigating" }] }),
        ),
      ).toMatchObject({ label: "1 active incident", tone: "warning" });
    },
  );

  it("ignores a tagged incident once no relevant component is disrupted", () => {
    expect(
      resolveOpenAIStatusNotice(
        statusSummary({
          indicator: "minor",
          components: [
            { name: "File uploads", status: "degraded_performance" },
            { name: "Responses", status: "operational" },
          ],
          incidents: [
            { impact: "minor", name: "File upload errors in ChatGPT", status: "identified" },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("ignores malformed responses", () => {
    expect(resolveOpenAIStatusNotice({ status: "down" })).toBeNull();
  });
});
