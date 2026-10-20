import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "device-usage-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "device-usage-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

it.effect(
  "records registered device tool failures and cleanup without collecting device arguments",
  () =>
    Effect.gen(function* () {
      const events: Array<{ event: string; properties: unknown }> = [];
      const layer = McpHttpServer.layerDeviceToolkit.pipe(
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(
          Layer.mock(DeviceService.DeviceService)({
            list: Effect.succeed({
              hosts: [],
              hostStatus: "disabled",
              hostStatuses: {},
              devices: [],
              sessions: [],
              onboardingCompleted: false,
              agentAccessEnabled: false,
              hubBasePath: "/api/device-hub",
              revision: 0,
            }),
            sessionsForThread: () => Effect.succeed([]),
            close: () => Effect.void,
          }),
        ),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "device-feature-usage-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(
          Layer.succeed(AnalyticsService.AnalyticsService, {
            recordOwners: () => Effect.void,
            record: (event, properties) =>
              Effect.sync(() => {
                events.push({ event, properties });
              }),
            flush: Effect.void,
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        for (const [name, args] of [
          ["device_list", {}],
          ["device_open", { deviceId: "synthetic-private-device", platform: "android" }],
          ["device_screenshot", {}],
        ] as const) {
          const result = yield* server.callTool({ name, arguments: args });
          expect(result.isError).toBe(true);
        }
        expect((yield* server.callTool({ name: "device_close", arguments: {} })).isError).toBe(
          false,
        );
      }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("device-usage-environment"),
          requestNamespace: "device-usage-session",
          thread: {
            threadId: ThreadId.make("device-usage-thread"),
            providerSessionId: "device-usage-provider-session",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["device"] as const),
          issuedAt: 1,
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provide(layer),
      );
      expect(events.map(({ properties }) => properties)).toEqual([
        {
          feature: "devices",
          action: "list",
          source: "agent",
          outcome: "failure",
          failureReason: "unavailable",
          durationMs: 0,
        },
        {
          feature: "devices",
          action: "open",
          source: "agent",
          devicePlatform: "android",
          deviceLocation: "local",
          outcome: "failure",
          failureReason: "unavailable",
          durationMs: 0,
        },
        {
          feature: "devices",
          action: "snapshot",
          source: "agent",
          outcome: "failure",
          failureReason: "unavailable",
          durationMs: 0,
        },
        { feature: "devices", action: "close", source: "agent", outcome: "success", durationMs: 0 },
      ]);
    }),
);
