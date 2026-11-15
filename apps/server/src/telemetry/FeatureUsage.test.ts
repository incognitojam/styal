import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { EnvironmentId } from "@t3tools/contracts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import { expect, it } from "@effect/vitest";
import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2Command,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { commandFeatureUsage, featureUsage } from "./FeatureUsage.ts";

const command = Schema.decodeUnknownSync(OrchestrationV2Command);
const ids = { commandId: "command-private", threadId: "thread-private" };

it("ignores messages, housekeeping commands, and untracked RPCs", () => {
  expect(
    commandFeatureUsage(
      command({
        ...ids,
        type: "message.dispatch",
        messageId: "message-private",
        text: "secret prompt",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      }),
    ),
  ).toBe(undefined);
  expect(
    commandFeatureUsage(
      command({ ...ids, type: "thread.visit", visitedAt: "2026-10-24T00:00:00.000Z" }),
    ),
  ).toBe(undefined);
  expect(featureUsage(WS_METHODS.terminalWrite, { data: "rm -rf" })).toBe(undefined);
});

it("leaves thread launches to client.thread.started", () => {
  expect(
    featureUsage(ORCHESTRATION_V2_WS_METHODS.launchThread, {
      title: "Private title",
      workspaceStrategy: { type: "worktree", baseRef: "main", branch: "secret-branch" },
    }),
  ).toBe(undefined);
});

it("tells watching a pull request apart from unwatching it", () => {
  const watch = (watching: boolean) =>
    commandFeatureUsage(
      command({
        ...ids,
        type: "thread.pull-request.watch",
        host: "github.com",
        repository: "owner/private",
        number: 7,
        watching,
      }),
    );
  expect(watch(true)).toEqual({ feature: "thread.pull_request.watch", variant: "on" });
  expect(watch(false)).toEqual({ feature: "thread.pull_request.watch", variant: "off" });
});

it("reads RPC variants from enums, never from paths or text", () => {
  expect(
    featureUsage(WS_METHODS.shellOpenInEditor, { cwd: "/Users/someone/secret", editor: "cursor" }),
  ).toEqual({ feature: "editor.open", variant: "cursor" });
  expect(featureUsage(WS_METHODS.terminalOpen, { cwd: "/Users/someone/secret" })).toEqual({
    feature: "terminal.open",
  });
});

it("counts device opens, workflow approvals, settles and archives", () => {
  expect(
    featureUsage(WS_METHODS.deviceOpen, { platform: "ios", deviceId: "device-private" }),
  ).toEqual({ feature: "device.open" });
  expect(
    featureUsage(WS_METHODS.pullRequestsRunAction, { action: "approve-workflows", number: 7 }),
  ).toEqual({ feature: "pull_request.action", variant: "approve-workflows" });
  expect(
    featureUsage(WS_METHODS.pullRequestsRunAction, { action: "update-branch", number: 7 }),
  ).toEqual({ feature: "pull_request.action", variant: "update-branch" });
  expect(commandFeatureUsage(command({ ...ids, type: "thread.settle" }))).toEqual({
    feature: "thread.settle",
  });
  expect(commandFeatureUsage(command({ ...ids, type: "thread.archive" }))).toEqual({
    feature: "thread.archive",
  });
  expect(
    commandFeatureUsage(
      command({ ...ids, type: "thread.snooze", snoozedUntil: "2026-10-25T00:00:00.000Z" }),
    ),
  ).toEqual({
    feature: "thread.snooze",
  });
});

it("counts stopping a thread as the same interrupt as stopping its run", () => {
  const interrupt = { feature: "run.interrupt" };
  expect(
    commandFeatureUsage(command({ ...ids, type: "run.interrupt", runId: "run-private" })),
  ).toEqual(interrupt);
  expect(commandFeatureUsage(command({ ...ids, type: "thread.stop" }))).toEqual(interrupt);
});

it("counts the owner's guest share actions, and only guest message sends", () => {
  const send = (guestMessageId?: string) =>
    commandFeatureUsage(
      command({
        ...ids,
        type: "message.dispatch",
        messageId: "message-private",
        text: "secret prompt",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
        ...(guestMessageId === undefined ? {} : { guestMessageId }),
      }),
    );
  expect(send("guest-message-private")).toEqual({ feature: "guest_message.send" });
  expect(send()).toBe(undefined);
  expect(
    commandFeatureUsage(
      command({ ...ids, type: "thread.guest-message.dismiss", guestMessageId: "guest-private" }),
    ),
  ).toEqual({ feature: "guest_message.dismiss" });
  expect(commandFeatureUsage(command({ ...ids, type: "thread.guest-share.close" }))).toEqual({
    feature: "guest_share.close",
  });
  expect(featureUsage(WS_METHODS.guestShareCreate, { threadId: "thread-private" })).toEqual({
    feature: "guest_share.create",
  });
});

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("synthetic-environment"),
  requestNamespace: "synthetic-session",
  thread: undefined,
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "synthetic-client", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "synthetic-client", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect.each([
  "t3_thread_organize",
  "preview_status",
  "device_list",
  "hardware_list",
  "watch_workflow_run",
  "unwatch_workflow_run",
  "read_styal_guide",
  "report_styal_issue",
])("records only failed %s calls that hand off no work", (name) =>
  Effect.gen(function* () {
    const recorded = yield* Deferred.make<{ event: string; properties: object }>();
    const toolkit = Toolkit.make(
      Tool.make(name, {
        description: "Synthetic tool failure.",
        parameters: Schema.Struct({ fail: Schema.Boolean }),
        success: Schema.Struct({}),
        failure: Schema.String,
      }),
    );
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const call = (fail: boolean) =>
        server
          .callTool({ name, arguments: { fail } })
          .pipe(
            Effect.provideService(McpSchema.McpServerClient, client),
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          );
      expect((yield* call(false)).isError).not.toBe(true);
      expect((yield* call(true)).isError).toBe(true);
      expect(yield* Deferred.await(recorded)).toMatchObject({
        event: "mcp.tool.invoked",
        properties: { tool: name, outcome: "error" },
      });
    }).pipe(
      Effect.provide(
        McpHttpServer.toolkitRegistration(
          toolkit,
          McpToolAccess.toLayer(toolkit, {
            [name]: McpToolAccess.reads(({ fail }: { fail: boolean }) =>
              fail ? Effect.fail("Synthetic failure") : Effect.succeed({}),
            ),
          }),
        ).pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provide(
            Layer.succeed(AnalyticsService.AnalyticsService, {
              recordOwners: () => Effect.void,
              record: (event, properties) =>
                Deferred.succeed(recorded, { event, properties: properties ?? {} }).pipe(
                  Effect.asVoid,
                ),
              flush: Effect.void,
            }),
          ),
        ),
      ),
    );
  }),
);
