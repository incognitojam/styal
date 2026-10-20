import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DeviceHeldError,
  DeviceBootError,
  DeviceHostUnavailableError,
  DeviceId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import { DeviceActivity } from "../device/DeviceIdle.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("environment-device-test");
const threadId = ThreadId.make("thread-device-test");
const invocation = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) => ({
  environmentId,
  requestNamespace: "provider-session-device-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-device-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
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

const unused = Effect.die("not used");
const readiness = {
  hostId: "local",
  nodePath: process.execPath,
  hub: { origin: "http://hub.test" },
  devices: {
    list: unused,
    boot: () => unused,
    attach: () => unused,
    shutdown: () => unused,
    screenshot: () => unused,
  },
  run: () => unused,
  helpers: { serveSimAxSettings: null, serveSimCli: null },
  agentDevice: null,
};
const layerProjectsMock = Layer.mock(ProjectService.ProjectService)({
  getById: () => Effect.succeed(Option.none()),
});

const layerDeviceServiceMock = Layer.mock(DeviceService.DeviceService)({
  state: Effect.succeed(state),
  list: Effect.succeed(state),
  agentReadinessIfSupported: () => Effect.succeed(readiness),
  open: (input) =>
    Effect.succeed({
      threadId: input.threadId,
      hostId: "local",
      deviceId: input.deviceId,
      platform: input.platform,
      openedAt: "2026-09-08T00:00:00.000Z",
    }),

  sessionsForThread: (id) =>
    Effect.succeed(
      id === threadId
        ? [
            {
              threadId,
              hostId: "local",
              deviceId: DeviceId.make("UDID-1"),
              platform: "ios" as const,
              openedAt: "2026-09-08T00:00:00.000Z",
            },
          ]
        : [],
    ),
  screenshot: () => Effect.succeed({ device, png }),
  close: () => Effect.void,
  agentCli: Effect.succeed("/cli"),
  testHost: () => Effect.die("not used"),
  // As for an EAS device, agent-device knows the device by a different id than T3.
  agentTarget: () =>
    Effect.succeed({
      agentDeviceId: "SIM-UDID",
      args: ["--config", "/host.json", "--session", "thread-device"],
    }),
});

const layerTest = McpHttpServer.layerDeviceToolkit.pipe(
  Layer.provide(AnalyticsService.AnalyticsService.layerTest),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(layerDeviceServiceMock),
  Layer.provide(layerProjectsMock),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-device-toolkit-test-" })),
  Layer.provide(NodeServices.layer),
);

it.effect("returns the complete bounded launch diagnostics to the agent", () => {
  const diagnostics =
    "Emulator exited with code 1.\nTry manually: emulator -avd TestPhone\n" + "x".repeat(1_930);
  const failure = new DeviceBootError({
    hostId: "local",
    deviceId: "UDID-1",
    reason: "launch_failed",
    diagnostics: diagnostics.slice(0, 2_000),
    cause: { ok: false, error: diagnostics },
  });
  const failedDevices = Layer.mock(DeviceService.DeviceService)({
    list: Effect.succeed(state),
    agentReadinessIfSupported: () => Effect.succeed(readiness),
    agentTarget: () => Effect.succeed({ agentDeviceId: "UDID-1", args: [] }),
    open: () => Effect.fail(failure),
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
    expect(result.content).toEqual([{ type: "text", text: failure.message }]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      McpHttpServer.layerDeviceToolkit.pipe(
        Layer.provide(AnalyticsService.AnalyticsService.layerTest),
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(failedDevices),
        Layer.provide(layerProjectsMock),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-boot-error-test-" })),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});

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
      expect(openedContent.quickStart).toContain("--udid SIM-UDID");

      const shot = yield* server
        .callTool({ name: "device_screenshot", arguments: { deviceId: "UDID-1" } })
        .pipe(callWith(["device"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(shot.isError).toBe(false);
      expect(shot.content.map((entry) => entry.type)).toEqual(["text", "image"]);
      expect(shot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 1206, height: 2622 },
      });

      const foreign = yield* server
        .callTool({ name: "device_screenshot", arguments: { deviceId: "UDID-2" } })
        .pipe(callWith(["device"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(foreign.isError).toBe(true);
      expect(foreign.content.map((entry) => entry.type)).toEqual(["text"]);

      const denied = yield* server
        .callTool({ name: "device_list", arguments: {} })
        .pipe(callWith(["preview"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(denied.isError).toBe(true);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("rejects unavailable agent access before booting or opening a device", () => {
  const layerUnavailable = Layer.mock(DeviceService.DeviceService)({
    list: Effect.succeed(state),
    agentReadinessIfSupported: () =>
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
      McpHttpServer.layerDeviceToolkit.pipe(
        Layer.provide(AnalyticsService.AnalyticsService.layerTest),
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(layerUnavailable),
        Layer.provide(layerProjectsMock),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-device-toolkit-test-" }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});

it.effect("names the thread using a device and opens it only on a take-over", () => {
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
  const other = ThreadId.make("thread-other");
  const takeOvers: Array<boolean | undefined> = [];
  // Stands in for the device lifecycle layer, which refuses an in-use device without takeOver.
  const service = Layer.mock(DeviceService.DeviceService)({
    agentReadinessIfSupported: () => Effect.succeed(readiness),
    state: Effect.succeed(shared),
    list: Effect.succeed(shared),
    agentTarget: () =>
      Effect.succeed({ agentDeviceId: "emulator-5554", args: ["--session", "thread-device"] }),
    agentCli: Effect.succeed("/cli"),
    open: (input) => {
      takeOvers.push(input.takeOver);
      return input.takeOver === true
        ? Effect.succeed({
            threadId: input.threadId,
            hostId: "local",
            deviceId: input.deviceId,
            platform: input.platform,
            openedAt: "2026-10-09T00:00:01.000Z",
          })
        : Effect.fail(
            new DeviceHeldError({
              hostId: "local",
              deviceId: input.deviceId,
              threadIds: [other],
            }),
          );
    },
  });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string, args: Record<string, unknown>) =>
      server.callTool({ name, arguments: args }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["device"])),
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provideService(DeviceActivity, {
          ...DeviceActivity.defaultValue(),
          inUse: () =>
            Effect.succeed([{ threadId: other, hostId: "local", deviceId: "emulator-5554" }]),
        }),
      );
    const text = (result: { readonly content: ReadonlyArray<unknown> }) =>
      result.content.flatMap((part) =>
        typeof part === "object" && part !== null && "text" in part ? [part.text] : [],
      );

    const listed = yield* call("device_list", {});
    expect(listed.structuredContent).toMatchObject({
      open: [],
      openInOtherThreads: [
        { hostId: "local", deviceId: "emulator-5554", threadId: "thread-other", inUse: true },
      ],
    });

    const implicit = yield* call("device_open", { platform: "android" });
    expect(implicit.isError).toBe(true);
    expect(text(implicit).join("\n")).toContain(
      "Another thread is using pixel_7_api_37 (emulator-5554)",
    );
    expect(takeOvers).toEqual([]);

    const named = yield* call("device_open", { deviceId: "emulator-5554" });
    expect(named.isError).toBe(true);
    expect(text(named).join("\n")).toContain("in use by thread thread-other");

    const takenOver = yield* call("device_open", { deviceId: "emulator-5554", takeOver: true });
    expect(takenOver.isError).toBe(false);
    expect(takeOvers).toEqual([undefined, true]);
    // The mocked state keeps the other session, as a connected environment's hold would.
    expect((takenOver.structuredContent as { quickStart: string }).quickStart).toMatch(
      /^Thread thread-other also has this device open/,
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      McpHttpServer.layerDeviceToolkit.pipe(
        Layer.provide(layerProjectsMock),
        Layer.provide(AnalyticsService.AnalyticsService.layerTest),
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(service),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-device-shared-test-" }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});
