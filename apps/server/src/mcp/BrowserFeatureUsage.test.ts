import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const invocation = {
  environmentId,
  requestNamespace: "provider-session-mcp-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-mcp-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
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
const makeTestLayer = (analyticsLayer: Layer.Layer<AnalyticsService.AnalyticsService>) =>
  McpHttpServer.layerPreviewToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provideMerge(PreviewAutomationBroker.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-http-server-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(analyticsLayer),
  );
const snapshotResult = {
  url: "http://example.test/",
  title: "Example",
  loading: false,
  visibleText: "Example",
  interactiveElements: [],
  accessibilityTree: {},
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
  screenshot: {
    mimeType: "image/png",
    data: Buffer.from("png").toString("base64"),
    width: 10,
    height: 5,
  },
};

/** Answers every snapshot request on a fresh broker host with the given result. */
const serveSnapshots = (clientId: string, result: unknown) =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const connected = yield* Deferred.make<void>();
    const inputs: Array<unknown> = [];
    const events = yield* broker.connect({ clientId, environmentId });
    yield* Stream.runForEach(events, (event) => {
      if (event.type === "connected") return Deferred.succeed(connected, undefined);
      inputs.push(event.request.input);
      return broker.respond({
        clientId,
        connectionId: event.connectionId,
        requestId: event.request.requestId,
        ok: true,
        result,
      });
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(connected);
    return inputs;
  });

const callSnapshot = (args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "preview_snapshot", arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("counts screenshot-save errors as failed browser usage", () => {
  const outcomes: Array<unknown> = [];
  const analytics = Layer.succeed(AnalyticsService.AnalyticsService, {
    recordOwners: () => Effect.void,
    record: (_event, properties) =>
      Effect.sync(() => {
        outcomes.push(properties?.outcome);
      }),
    flush: Effect.void,
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      // A regular file where the artifacts directory should be makes every write fail.
      yield* fileSystem.writeFileString(config.browserArtifactsDir, "");
      yield* serveSnapshots("mcp-save-failure-client", snapshotResult);

      const snapshot = yield* callSnapshot({ save: true });

      expect(snapshot.isError).toBe(true);
      expect(outcomes).toEqual(["failure"]);
      expect(snapshot.content).toEqual([
        { type: "text", text: "Preview snapshot failed: PreviewScreenshotSaveError." },
      ]);
      expect(snapshot.structuredContent).toEqual({
        error: { _tag: "PreviewScreenshotSaveError", operation: "snapshot", failureCount: 1 },
      });
    }),
  ).pipe(Effect.provide(makeTestLayer(analytics)));
});

it.effect("records one browser usage event per tool, excluding internal status reads", () => {
  const recorded: Array<{
    event: string;
    properties: Readonly<Record<string, unknown>> | undefined;
  }> = [];
  const analytics = Layer.succeed(AnalyticsService.AnalyticsService, {
    recordOwners: () => Effect.void,
    record: (event, properties) =>
      Effect.sync(() => {
        recorded.push({ event, properties });
      }),
    flush: Effect.void,
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      // A browser call without an attached host is still a measured failed attempt.
      expect((yield* callSnapshot({})).isError).toBe(true);
      const inputs = yield* serveSnapshots("usage-client", snapshotResult);
      const clicked = yield* server
        .callTool({ name: "preview_click", arguments: { locator: "button" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(clicked.isError).toBe(false);
      // The click and its favicon/status metadata request both ran.
      expect(inputs).toHaveLength(2);
      expect(recorded).toEqual([
        {
          event: "feature.used",
          properties: {
            feature: "browser-tools",
            action: "snapshot",
            source: "agent",
            outcome: "failure",
            durationMs: expect.any(Number),
          },
        },
        {
          event: "feature.used",
          properties: {
            feature: "browser-tools",
            action: "click",
            source: "agent",
            outcome: "success",
            durationMs: expect.any(Number),
          },
        },
      ]);
    }),
  ).pipe(Effect.provide(makeTestLayer(analytics)));
});
