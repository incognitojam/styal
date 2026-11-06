import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as AnalyticsService from "../../../telemetry/AnalyticsService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import { AGENT_GUIDES } from "./guides.ts";

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

it.effect("returns the guide and records the topic only", () => {
  const recorded: Array<{ event: string; properties: unknown }> = [];
  const analytics = Layer.succeed(AnalyticsService.AnalyticsService, {
    recordOwners: () => Effect.void,
    record: (event, properties) => Effect.sync(() => void recorded.push({ event, properties })),
    flush: Effect.void,
  });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "read_styal_guide", arguments: { topic: "hardware" } })
      .pipe(Effect.provideService(McpSchema.McpServerClient, client));
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ guide: AGENT_GUIDES.hardware });
    expect(recorded).toEqual([
      {
        event: "feature.used",
        properties: {
          feature: "agent-guides",
          action: "read",
          source: "agent",
          guideTopic: "hardware",
          outcome: "success",
          durationMs: expect.any(Number),
        },
      },
    ]);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerGuideToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(analytics),
      ),
    ),
  );
});
