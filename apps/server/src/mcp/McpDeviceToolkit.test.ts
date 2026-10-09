import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DeviceHostUnavailableError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const environmentId = EnvironmentId.make("environment-device-test");
const threadId = ThreadId.make("thread-device-test");
const invocation = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) => ({
  environmentId,
  threadId,
  providerSessionId: "provider-session-device-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});
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

const device = {
  hostId: "local",
  id: "UDID-1",
  platform: "ios" as const,
  name: "iPhone 17 Pro",
  version: "iOS 27.0",
  booted: true,
  physical: false,
};
const state = {
  hosts: [
    {
      id: "local",
      kind: "local" as const,
      label: "This machine",
      platforms: [
        { platform: "ios" as const, available: true },
        { platform: "android" as const, available: false, reason: "No SDK" },
      ],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "ready" as const,
  hostStatuses: { local: { status: "ready" as const } },
  devices: [device],
  sessions: [],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device-hub",
  revision: 1,
};
const png = new Uint8Array(24);
new DataView(png.buffer).setUint32(0, 0x89504e47);
new DataView(png.buffer).setUint32(4, 0x0d0a1a0a);
new DataView(png.buffer).setUint32(12, 0x49484452);
new DataView(png.buffer).setUint32(16, 1206);
new DataView(png.buffer).setUint32(20, 2622);

const DeviceServiceMock = Layer.mock(DeviceService.DeviceService)({
  state: Effect.succeed(state),
  list: Effect.succeed(state),
  open: (input) =>
    Effect.succeed({
      threadId: input.threadId,
      hostId: "local",
      deviceId: input.deviceId,
      platform: input.platform,
      openedAt: "2026-09-08T00:00:00.000Z",
    }),
  sessionsForThread: () => Effect.succeed([]),
  screenshot: () => Effect.succeed({ device, png }),
  close: () => Effect.void,
  agentCli: Effect.succeed("/cli"),
  testHost: () => Effect.die("not used"),
  agentTarget: () => Effect.succeed(["--config", "/host.json", "--session", "thread-device"]),
});

const TestLayer = McpHttpServer.DeviceToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(DeviceServiceMock),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-device-toolkit-test-" })),
  Layer.provide(NodeServices.layer),
);

it.effect("registers the device tools and returns the screenshot as image content", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const names = server.tools.map(({ tool }) => tool.name).toSorted();
      expect(names).toEqual(["device_close", "device_list", "device_open", "device_screenshot"]);

      const callWith = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) =>
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities));

      const opened = yield* server
        .callTool({ name: "device_open", arguments: { platform: "ios" } })
        .pipe(callWith(["device"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(opened.isError).toBe(false);
      const openedContent = opened.structuredContent as { quickStart: string };
      expect(openedContent.quickStart).toContain("--udid UDID-1");

      const shot = yield* server
        .callTool({ name: "device_screenshot", arguments: { deviceId: "UDID-1" } })
        .pipe(callWith(["device"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(shot.isError).toBe(false);
      expect(shot.content.map((entry) => entry.type)).toEqual(["text", "image"]);
      expect(shot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 1206, height: 2622 },
      });

      const denied = yield* server
        .callTool({ name: "device_list", arguments: {} })
        .pipe(callWith(["preview"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(denied.isError).toBe(true);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("rejects unavailable agent access before booting or opening a device", () => {
  const unavailable = Layer.mock(DeviceService.DeviceService)({
    list: Effect.succeed(state),
    agentTarget: () =>
      Effect.fail(
        new DeviceHostUnavailableError({ hostId: "local", reason: "Agent access is disabled." }),
      ),
    open: () => Effect.die("Must not boot or register a device when agent access fails"),
  });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "device_open", arguments: { platform: "ios" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["device"])),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Agent access is disabled."),
        }),
      ]),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      McpHttpServer.DeviceToolkitRegistrationLive.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(unavailable),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});

it.effect("reports another thread's device and does not open it unless named", () => {
  const emulator = {
    hostId: "local",
    id: "emulator-5554",
    platform: "android" as const,
    name: "pixel_7_api_37",
    version: "Android 17.0",
    booted: true,
    physical: false,
  };
  const shared = {
    ...state,
    hosts: [
      {
        ...state.hosts[0]!,
        platforms: [
          { platform: "ios" as const, available: false, reason: "No Xcode" },
          { platform: "android" as const, available: true },
        ],
      },
    ],
    devices: [emulator],
    sessions: [
      {
        threadId: ThreadId.make("thread-other"),
        hostId: "local",
        deviceId: "emulator-5554",
        platform: "android" as const,
        openedAt: "2026-10-09T00:00:00.000Z",
      },
    ],
  };
  let opened = 0;
  const service = Layer.mock(DeviceService.DeviceService)({
    state: Effect.succeed(shared),
    list: Effect.succeed(shared),
    agentTarget: () => Effect.succeed(["--session", "thread-device"]),
    agentCli: Effect.succeed("/cli"),
    open: (input) =>
      Effect.sync(() => {
        opened += 1;
        return {
          threadId: input.threadId,
          hostId: "local",
          deviceId: input.deviceId,
          platform: input.platform,
          openedAt: "2026-10-09T00:00:01.000Z",
        };
      }),
  });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string, args: Record<string, unknown>) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["device"])),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const listed = yield* call("device_list", {});
    expect(listed.structuredContent).toMatchObject({
      open: [],
      openInOtherThreads: [{ hostId: "local", deviceId: "emulator-5554" }],
    });

    const implicit = yield* call("device_open", { platform: "android" });
    expect(implicit.isError).toBe(true);
    expect(implicit.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Another thread has pixel_7_api_37 (emulator-5554) open"),
        }),
      ]),
    );
    expect(opened).toBe(0);

    const named = yield* call("device_open", { deviceId: "emulator-5554" });
    expect(named.isError).toBe(false);
    expect((named.structuredContent as { quickStart: string }).quickStart).toMatch(
      /^Another thread also has this device open/,
    );
    expect(opened).toBe(1);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      McpHttpServer.DeviceToolkitRegistrationLive.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(service),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-device-shared-test-" }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});
