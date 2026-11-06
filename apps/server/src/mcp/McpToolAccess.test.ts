import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as OrchestratorHandlers from "./toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as Repositories from "../sourceControl/SourceControlRepositoryService.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ProjectHandlers from "./toolkits/project/handlers.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import * as ThreadHandlers from "./toolkits/thread/handlers.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const autoThreadId = ThreadId.make("thread:auto");
const supervisedThreadId = ThreadId.make("thread:supervised");
const planThreadId = ThreadId.make("thread:plan");
const fullAccessThreadId = ThreadId.make("thread:full-access");
const endedThreadId = ThreadId.make("thread:ended");
const backgroundThreadId = ThreadId.make("thread:background");
const oldProviderThreadId = ThreadId.make("thread:old-provider-background");
const archivedThreadId = ThreadId.make("thread:archived-background");
const unknownOwnerThreadId = ThreadId.make("thread:unknown-background-owner");

const backgroundShell = (threadId: ThreadId, providerInstanceId: ProviderInstanceId) => ({
  ...liveThreadShell(threadId, { activeRunId: null }),
  pendingBackgroundTasks: [
    { taskId: "task:background", kind: "subagent" as const, providerInstanceId },
  ],
});

const shells = new Map([
  [autoThreadId, liveThreadShell(autoThreadId, { runtimeMode: "auto" })],
  [supervisedThreadId, liveThreadShell(supervisedThreadId, { runtimeMode: "approval-required" })],
  [
    planThreadId,
    liveThreadShell(planThreadId, { runtimeMode: "approval-required", interactionMode: "plan" }),
  ],
  [fullAccessThreadId, liveThreadShell(fullAccessThreadId)],
  [endedThreadId, liveThreadShell(endedThreadId, { activeRunId: null })],
  [backgroundThreadId, backgroundShell(backgroundThreadId, ProviderInstanceId.make("codex"))],
  [oldProviderThreadId, backgroundShell(oldProviderThreadId, ProviderInstanceId.make("claude"))],
  [
    archivedThreadId,
    {
      ...backgroundShell(archivedThreadId, ProviderInstanceId.make("codex")),
      archivedAt: liveThreadShell(archivedThreadId).updatedAt,
    },
  ],
  [
    unknownOwnerThreadId,
    {
      ...liveThreadShell(unknownOwnerThreadId, { activeRunId: null }),
      pendingBackgroundTasks: [{ taskId: "task:unknown", kind: "subagent" as const }],
    },
  ],
]);

const threadCaller = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const clientCaller = (
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Claude Code", access },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const probe = {
  success: Schema.Struct({ ran: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
};
const ProbeToolkit = Toolkit.make(
  Tool.make("reads", probe),
  Tool.make("reads_as_caller", probe),
  Tool.make("acts_as_caller", probe),
  Tool.make("writes", probe),
  Tool.make("writes_with_capability", probe),
  Tool.make("writes_threads", {
    ...probe,
    parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  }),
  Tool.make("starts_threads", {
    ...probe,
    parameters: Schema.Struct({
      runtimeMode: Schema.optional(RuntimeMode),
      interactionMode: Schema.optional(ProviderInteractionMode),
    }),
  }),
  Tool.make("writes_environment", probe),
  Tool.make("t3_environment_link", probe),
  Tool.make("run_scheduled_task_now", probe),
  Tool.make("t3_project_create", probe),
  Tool.make("t3_project_clone", probe),
  Tool.make("t3_project_update", probe),
  Tool.make("t3_project_delete", probe),
  Tool.make("t3_environment_unlink", probe),
  Tool.make("t3_environment_preferences_update", probe),
);
const ran = Effect.succeed({ ran: "ran" });
const probeHandlers: McpToolAccess.Handlers<typeof ProbeToolkit.tools> = {
  reads: McpToolAccess.reads(() => ran),
  reads_as_caller: McpToolAccess.readsAsCaller(() => ran),
  acts_as_caller: McpToolAccess.actsAsCaller(() => ran),
  writes: McpToolAccess.writes(() => ran),
  writes_with_capability: McpToolAccess.writesWithCapability(() => ran),
  writes_threads: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    () => ran,
  ),
  starts_threads: McpToolAccess.startsThreads(
    (input) => input,
    (_, modes) => Effect.succeed({ ran: `${modes.runtimeMode}/${modes.interactionMode}` }),
    "stamped",
  ),
  writes_environment: McpToolAccess.writesEnvironment(() => ran),
  t3_environment_link: McpToolAccess.writesEnvironment(() => ran, { auto: "allowed" }),
  run_scheduled_task_now: McpToolAccess.writesEnvironment(() => ran, { auto: "allowed" }),
  t3_project_create: McpToolAccess.writesEnvironment(() => ran, { auto: "allowed" }),
  t3_project_clone: McpToolAccess.writesEnvironment(() => ran, { auto: "allowed" }),
  t3_project_update: McpToolAccess.writesEnvironment(() => ran, {}),
  t3_project_delete: McpToolAccess.writesEnvironment(() => ran, {}),
  t3_environment_unlink: McpToolAccess.writesEnvironment(() => ran, {}),
  t3_environment_preferences_update: McpToolAccess.writesEnvironment(() => ran, {}),
};
const layerProbeHandlers = McpToolAccess.toLayer(ProbeToolkit, probeHandlers);

const unchecked = () => ran;

// `@ts-expect-error` fails the build if one ever compiles. Never called.
export const refusedAtCompileTime = () => {
  McpToolAccess.toLayer(ProbeToolkit, {
    ...probeHandlers,
    // @ts-expect-error a handler that skips its declaration
    reads: unchecked,
  });
  McpToolAccess.toLayer(ProbeToolkit, {
    ...probeHandlers,
    // @ts-expect-error a declaration's fields copied onto an unchecked handler
    reads: Object.assign(
      unchecked,
      McpToolAccess.reads(() => ran),
    ),
  });
  // @ts-expect-error a declaration built outside McpToolAccess
  McpToolAccess.Declaration.make(unchecked);
  // @ts-expect-error a declaration constructed directly
  new McpToolAccess.Declaration(unchecked); // oxlint-disable-line eslint/no-new -- This type-contract test checks direct construction.
  // @ts-expect-error a handlers layer built outside McpToolAccess
  McpToolAccess.HandlersLayer.make(Layer.empty);
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off
  McpHttpServer.toolkitRegistration(
    ProbeToolkit,
    // @ts-expect-error a handlers layer that skipped `McpToolAccess.toLayer`
    ProbeToolkit.toLayer({
      reads: unchecked,
      reads_as_caller: unchecked,
      acts_as_caller: unchecked,
      writes: unchecked,
      writes_with_capability: unchecked,
      writes_threads: unchecked,
      starts_threads: unchecked,
      writes_environment: unchecked,
      t3_environment_link: unchecked,
      run_scheduled_task_now: unchecked,
      t3_project_create: unchecked,
      t3_project_clone: unchecked,
      t3_project_update: unchecked,
      t3_project_delete: unchecked,
      t3_environment_unlink: unchecked,
      t3_environment_preferences_update: unchecked,
    }),
  );
};

const probeServer = (threads: Layer.Layer<ThreadManagement.ThreadManagementService>) =>
  McpHttpServer.toolkitRegistration(ProbeToolkit, layerProbeHandlers).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(threads),
  );

const decodeOutcome = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([Schema.Struct({ ran: Schema.String }), Schema.Struct({ code: Schema.String })]),
  ),
);

const call = (
  tool: string,
  scope: McpInvocationContext.McpInvocationScope,
  args: Record<string, unknown> = {},
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: tool, arguments: args })),
    Effect.flatMap(({ content }) =>
      decodeOutcome(content.map((part) => (part.type === "text" ? part.text : "")).join("")),
    ),
    Effect.map((outcome) => ("code" in outcome ? outcome.code : outcome.ran)),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const supervised = threadCaller(supervisedThreadId);
const plan = threadCaller(planThreadId);
const fullAccess = threadCaller(fullAccessThreadId);
const ended = threadCaller(endedThreadId);
const background = threadCaller(backgroundThreadId);
const oldProviderBackground = threadCaller(oldProviderThreadId);
const archivedBackground = threadCaller(archivedThreadId);
const unknownOwnerBackground = threadCaller(unknownOwnerThreadId);
const mismatchedProvider = {
  ...background,
  thread: { ...background.thread!, providerInstanceId: ProviderInstanceId.make("claude") },
};
const supervisedClient = clientCaller("approval-required");
const fullAccessClient = clientCaller("full-access");
const readOnlyClient = clientCaller("read-only");
const linkedClient: McpInvocationContext.McpInvocationScope = {
  ...supervisedClient,
  client: { ...supervisedClient.client!, linked: true },
};
// A full-access link's agents can do anything this environment's user can.
const fullAccessLinkedClient: McpInvocationContext.McpInvocationScope = {
  ...fullAccessClient,
  client: { ...fullAccessClient.client!, linked: true },
};
const previewOnly = { ...fullAccess, capabilities: new Set(["preview"] as const) };

it.effect.each([
  ["t3_environment_link", threadCaller(autoThreadId), {}, "ran"],
  ["t3_environment_link", supervised, {}, "capability_denied"],
  ["t3_environment_link", fullAccess, {}, "ran"],
  ["run_scheduled_task_now", threadCaller(autoThreadId), {}, "ran"],
  ["run_scheduled_task_now", supervised, {}, "capability_denied"],
  ["run_scheduled_task_now", fullAccess, {}, "ran"],
  ["t3_project_create", threadCaller(autoThreadId), {}, "ran"],
  ["t3_project_create", supervised, {}, "capability_denied"],
  ["t3_project_create", fullAccess, {}, "ran"],
  ["t3_project_clone", threadCaller(autoThreadId), {}, "ran"],
  ["t3_project_clone", supervised, {}, "capability_denied"],
  ["t3_project_clone", fullAccess, {}, "ran"],
  ["t3_project_update", threadCaller(autoThreadId), {}, "capability_denied"],
  ["t3_project_update", supervised, {}, "capability_denied"],
  ["t3_project_update", fullAccess, {}, "ran"],
  ["t3_project_delete", threadCaller(autoThreadId), {}, "capability_denied"],
  ["t3_project_delete", supervised, {}, "capability_denied"],
  ["t3_project_delete", fullAccess, {}, "ran"],
  ["t3_environment_unlink", threadCaller(autoThreadId), {}, "capability_denied"],
  ["t3_environment_unlink", supervised, {}, "capability_denied"],
  ["t3_environment_unlink", fullAccess, {}, "ran"],
  ["t3_environment_preferences_update", threadCaller(autoThreadId), {}, "capability_denied"],
  ["t3_environment_preferences_update", supervised, {}, "capability_denied"],
  ["t3_environment_preferences_update", fullAccess, {}, "ran"],

  ["reads", ended, {}, "ran"],
  ["reads", supervisedClient, {}, "ran"],
  ["reads", readOnlyClient, {}, "ran"],

  ["writes", readOnlyClient, {}, "capability_denied"],
  ["writes_threads", readOnlyClient, { threadId: supervisedThreadId }, "capability_denied"],
  ["starts_threads", readOnlyClient, {}, "capability_denied"],
  ["writes_environment", readOnlyClient, {}, "capability_denied"],

  ["reads_as_caller", ended, {}, "ran"],
  ["reads_as_caller", fullAccessClient, {}, "thread_credential_required"],
  ["acts_as_caller", supervised, {}, "ran"],
  ["acts_as_caller", ended, {}, "parent_not_active"],
  ["acts_as_caller", background, {}, "ran"],
  ["acts_as_caller", oldProviderBackground, {}, "parent_not_active"],
  ["acts_as_caller", mismatchedProvider, {}, "parent_not_active"],
  ["acts_as_caller", archivedBackground, {}, "parent_not_active"],
  ["acts_as_caller", unknownOwnerBackground, {}, "parent_not_active"],
  ["acts_as_caller", fullAccessClient, {}, "thread_credential_required"],

  ["writes", supervised, {}, "ran"],
  ["writes", ended, {}, "parent_not_active"],
  ["writes", background, {}, "ran"],
  ["writes", oldProviderBackground, {}, "parent_not_active"],
  ["writes", supervisedClient, {}, "ran"],
  ["writes", previewOnly, {}, "capability_denied"],
  ["writes_environment", previewOnly, {}, "capability_denied"],

  ["writes_with_capability", previewOnly, {}, "ran"],
  ["writes_with_capability", readOnlyClient, {}, "capability_denied"],
  ["writes_with_capability", ended, {}, "parent_not_active"],
  ["writes", linkedClient, {}, "capability_denied"],
  ["writes_with_capability", linkedClient, {}, "capability_denied"],
  ["writes", fullAccessLinkedClient, {}, "ran"],
  ["writes_with_capability", fullAccessLinkedClient, {}, "ran"],

  ["writes_threads", supervised, {}, "ran"],
  ["writes_threads", supervised, { threadId: planThreadId }, "ran"],
  [
    "writes_threads",
    supervised,
    { threadId: fullAccessThreadId },
    "runtime_mode_escalation_denied",
  ],
  ["writes_threads", plan, { threadId: supervisedThreadId }, "interaction_mode_escalation_denied"],
  ["writes_threads", fullAccess, { threadId: supervisedThreadId }, "ran"],
  ["writes_threads", ended, { threadId: supervisedThreadId }, "parent_not_active"],
  ["writes_threads", supervisedClient, { threadId: supervisedThreadId }, "ran"],
  [
    "writes_threads",
    supervisedClient,
    { threadId: fullAccessThreadId },
    "runtime_mode_escalation_denied",
  ],
  ["writes_threads", supervised, { threadId: "thread:missing" }, "ran"],

  ["starts_threads", supervised, {}, "approval-required/default"],
  ["starts_threads", supervised, { runtimeMode: "full-access" }, "runtime_mode_escalation_denied"],
  ["starts_threads", plan, {}, "approval-required/plan"],
  ["starts_threads", plan, { interactionMode: "default" }, "interaction_mode_escalation_denied"],
  ["starts_threads", fullAccess, { runtimeMode: "auto", interactionMode: "plan" }, "auto/plan"],
  ["starts_threads", ended, {}, "parent_not_active"],
  ["starts_threads", supervisedClient, {}, "approval-required/default"],
  ["starts_threads", supervisedClient, { runtimeMode: "auto" }, "runtime_mode_escalation_denied"],
  ["starts_threads", fullAccessClient, { runtimeMode: "full-access" }, "full-access/default"],

  ["writes_environment", fullAccess, {}, "ran"],
  ["writes_environment", supervised, {}, "capability_denied"],
  ["writes_environment", plan, {}, "capability_denied"],
  ["writes_environment", fullAccessClient, {}, "ran"],
  ["writes_environment", supervisedClient, {}, "capability_denied"],
] as const)("%s from %o with %o: %s", ([tool, scope, args, expected]) =>
  call(tool, scope, args).pipe(
    Effect.map((outcome) => expect(outcome).toBe(expected)),
    Effect.provide(
      probeServer(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
        }),
      ),
    ),
  ),
);

it("refuses a declaration or handlers layer that only wears another's fields", () => {
  const copiedDeclaration = Object.assign(
    unchecked,
    McpToolAccess.reads(() => ran),
  );
  expect(() =>
    McpToolAccess.toLayer(ProbeToolkit, {
      ...probeHandlers,
      // @ts-expect-error a declaration's fields copied onto an unchecked handler
      reads: copiedDeclaration,
    }),
  ).toThrow(TypeError);
  const copiedLayer = Object.assign(Layer.empty, layerProbeHandlers);
  expect(() => McpToolAccess.HandlersLayer.layer(copiedLayer)).toThrow(TypeError);
});

it.effect("refuses a change when the calling thread cannot be read", () =>
  call("writes", supervised).pipe(
    Effect.map((outcome) => expect(outcome).toBe("orchestration_error")),
    Effect.provide(
      probeServer(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.fail(new OrchestratorProjectionError({ threadId, cause: "unreadable" })),
        }),
      ),
    ),
  ),
);

const box = EnvironmentId.make("environment-box");
const here = EnvironmentId.make("environment");
const linkedProbe = {
  ...probe,
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
  }),
};
const LinkedProbeToolkit = Toolkit.make(
  Tool.make("reads", linkedProbe),
  Tool.make("writes", linkedProbe),
  Tool.make("writes_with_capability", linkedProbe),
  Tool.make("writes_threads", linkedProbe),
  Tool.make("starts_threads", linkedProbe),
  Tool.make("writes_environment", linkedProbe),
  Tool.make("writes_environment_auto", linkedProbe),
);
/** Runs here, and tells whether `environmentId` reached the handler. */
const ranHere = <P extends object>(params: P) =>
  Effect.succeed({ ran: "environmentId" in params ? "saw environmentId" : "here" });

const linkedProbeServer = McpHttpServer.toolkitRegistration(
  LinkedProbeToolkit,
  McpToolAccess.toLayer(LinkedProbeToolkit, {
    reads: McpToolAccess.reads(ranHere),
    writes: McpToolAccess.writes(ranHere),
    writes_with_capability: McpToolAccess.writesWithCapability(ranHere),
    writes_threads: McpToolAccess.writesThreads((input) => [input.threadId], ranHere),
    starts_threads: McpToolAccess.startsThreads((input) => input, ranHere, "stamped"),
    writes_environment: McpToolAccess.writesEnvironment(ranHere),
    writes_environment_auto: McpToolAccess.writesEnvironment(ranHere, { auto: "allowed" }),
  }),
).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
    }),
  ),
  // Stands in for the linked environment, answering with where the call went.
  Layer.provide(
    Layer.mock(PeerForwarding.PeerForwarding)({
      call: (_scope, tool, environmentId) =>
        Effect.succeed({ ran: `${tool.name} in ${environmentId}` } as never),
    }),
  ),
);

it.effect.each([
  [
    "writes_environment_auto",
    threadCaller(autoThreadId),
    { environmentId: box },
    "writes_environment_auto in environment-box",
  ],
  ["writes_environment_auto", supervised, { environmentId: box }, "capability_denied"],
  [
    "writes_environment_auto",
    { ...clientCaller("auto"), client: { ...clientCaller("auto").client!, linked: true } },
    {},
    "capability_denied",
  ],
  ["reads", supervised, { environmentId: box }, "reads in environment-box"],
  ["reads", supervised, { environmentId: here }, "here"],
  ["reads", supervised, {}, "here"],

  // The caller is checked here before anything goes.
  ["writes", readOnlyClient, { environmentId: box }, "capability_denied"],
  ["writes", ended, { environmentId: box }, "parent_not_active"],
  ["writes", supervised, { environmentId: box }, "writes in environment-box"],
  ["writes_with_capability", readOnlyClient, { environmentId: box }, "capability_denied"],
  [
    "starts_threads",
    plan,
    { environmentId: box, interactionMode: "default" },
    "interaction_mode_escalation_denied",
  ],
  ["starts_threads", plan, { environmentId: box }, "starts_threads in environment-box"],
  ["writes_environment", supervised, { environmentId: box }, "capability_denied"],
  [
    "writes_environment",
    fullAccess,
    { environmentId: box },
    "writes_environment in environment-box",
  ],
  ["writes_environment", fullAccess, { environmentId: here }, "here"],

  // A thread id names a thread where the call runs, and is checked there.
  [
    "writes_threads",
    supervised,
    { environmentId: box, threadId: fullAccessThreadId },
    "writes_threads in environment-box",
  ],
  [
    "writes_threads",
    supervised,
    { environmentId: here, threadId: fullAccessThreadId },
    "runtime_mode_escalation_denied",
  ],
] as const)("a linked %s from %o with %o: %s", ([tool, scope, args, expected]) =>
  call(tool, scope, args).pipe(
    Effect.map((outcome) => expect(outcome).toBe(expected)),
    Effect.provide(linkedProbeServer),
  ),
);

it.effect("refuses a linked environment to a tool that acts as its calling thread", () =>
  Effect.gen(function* () {
    const CallerToolkit = Toolkit.make(Tool.make("acts_as_caller", linkedProbe));
    const built = yield* Layer.build(
      McpToolAccess.HandlersLayer.layer(
        McpToolAccess.toLayer(CallerToolkit, {
          acts_as_caller: McpToolAccess.actsAsCaller(ranHere),
        }),
      ),
    ).pipe(Effect.scoped, Effect.exit);
    expect(Exit.isFailure(built) && Cause.hasDies(built.cause)).toBe(true);
  }),
);

const CreateToolkit = Toolkit.make(ProjectToolkit.tools.t3_project_create);
const RunToolkit = Toolkit.make(ThreadToolkit.tools.run_scheduled_task_now);

it.effect.each([
  ["auto", {}, "created"],
  ["auto", { scripts: [] }, "capability_denied"],
  ["auto", { scripts: [], environmentId: box }, "capability_denied"],
  ["auto", { defaultModelSelection: { instanceId: "codex", model: "test" } }, "capability_denied"],
  ["approval-required", {}, "capability_denied"],
  ["full-access", { scripts: [] }, "created"],
] as const)("project create from %s with %o", ([runtimeMode, extra, expected]) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server.callTool({
      name: "t3_project_create",
      arguments: {
        title: "Synthetic project",
        workspaceRoot: "/projects/synthetic",
        ...extra,
      },
    });
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    expect(text).toContain(expected);
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, clientCaller(runtimeMode)),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
    Effect.provide(
      McpHttpServer.toolkitRegistration(
        CreateToolkit,
        McpToolAccess.toLayer(CreateToolkit, {
          t3_project_create: ProjectHandlers.declarations.t3_project_create,
        }),
      ).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(
          Layer.mock(ProjectService.ProjectService)({
            create: () =>
              Effect.succeed({
                id: "created",
                title: "Synthetic project",
                workspaceRoot: "/projects/synthetic",
                scripts: [],
                defaultModelSelection: null,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                deletedAt: null,
              } as never),
          }),
        ),
        Layer.provide(
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
          }),
        ),
        Layer.provide(NodeCrypto.layer),
      ),
    ),
  ),
);

it.effect.each([
  ["auto", "auto", "running"],
  ["auto", "full-access", "runtime_mode_escalation_denied"],
  ["approval-required", "approval-required", "capability_denied"],
  ["full-access", "full-access", "running"],
] as const)("scheduled run from %s with task %s", ([runtimeMode, taskMode, expected]) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server.callTool({
      name: "run_scheduled_task_now",
      arguments: { taskId: "task:test" },
    });
    expect(
      result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    ).toContain(expected);
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, clientCaller(runtimeMode)),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
    Effect.provide(
      McpHttpServer.toolkitRegistration(
        RunToolkit,
        McpToolAccess.toLayer(RunToolkit, {
          run_scheduled_task_now: ThreadHandlers.declarations.run_scheduled_task_now,
        }),
      ).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(
          Layer.mock(ScheduledTasks.ScheduledTaskService)({
            list: () =>
              Effect.succeed({
                tasks: [{ id: "task:test", runtimeMode: taskMode, interactionMode: "default" }],
              } as never),
            runNow: () =>
              Effect.succeed({
                task: { id: "task:test", lastRunStatus: "running", runCount: 1, nextRunAt: null },
                threadId: null,
              } as never),
          }),
        ),
      ),
    ),
  ),
);

const AutoUsageToolkit = Toolkit.make(
  ProjectToolkit.tools.t3_project_create,
  ProjectToolkit.tools.t3_project_clone,
  ThreadToolkit.tools.run_scheduled_task_now,
  OrchestratorToolkit.tools.t3_environment_link,
);

it.effect.each(
  (
    [
      [
        "t3_project_create",
        "project_create",
        { title: "Synthetic private title", workspaceRoot: "/projects/synthetic-private" },
      ],
      [
        "t3_project_clone",
        "project_clone",
        {
          remoteUrl: "https://example.test/synthetic-private.git",
          destinationPath: "/projects/synthetic-private",
        },
      ],
      ["run_scheduled_task_now", "scheduled_run", { taskId: "task:synthetic-private" }],
      ["t3_environment_link", "link", { hint: "synthetic private machine" }],
    ] as const
  ).flatMap(([tool, action, args]) =>
    (["success", "refused", "failure"] as const).map((outcome) => ({
      tool,
      action,
      args,
      outcome,
    })),
  ),
)("records Auto $tool $outcome once without operation data", ({ tool, action, args, outcome }) =>
  Effect.gen(function* () {
    const events: Array<unknown> = [];
    const success = <A>(value: A) =>
      outcome === "failure" ? Effect.die("synthetic private failure") : Effect.succeed(value);
    const scope = clientCaller("auto");
    const result = yield* McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name: String(tool), arguments: args })),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...scope,
        client: {
          ...scope.client!,
          narrowedTo: {
            runtimeMode: "auto",
            interactionMode: outcome === "refused" ? "plan" : "default",
          },
        },
      }),
      Effect.provideService(McpSchema.McpServerClient, mcpClient),
      Effect.provide(
        McpHttpServer.toolkitRegistration(
          AutoUsageToolkit,
          McpToolAccess.toLayer(AutoUsageToolkit, {
            t3_project_create: ProjectHandlers.declarations.t3_project_create,
            t3_project_clone: ProjectHandlers.declarations.t3_project_clone,
            run_scheduled_task_now: ThreadHandlers.declarations.run_scheduled_task_now,
            t3_environment_link: OrchestratorHandlers.handlers.t3_environment_link,
          }),
        ).pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(
            Layer.succeed(
              AnalyticsService.AnalyticsService,
              AnalyticsService.AnalyticsService.of({
                recordOwners: () => Effect.void,
                flush: Effect.void,
                record: (event, properties) =>
                  Effect.sync(() => {
                    if (event === "feature.used") events.push({ event, properties });
                  }),
              }),
            ),
          ),
          Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
          Layer.provide(Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({})),
          Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
          Layer.provide(
            Layer.mock(PeerLinkRequests.PeerLinkRequests)({
              request: () => success({ status: "pending", turnItemId: "card:synthetic" } as never),
            }),
          ),
          Layer.provide(
            Layer.mock(Repositories.SourceControlRepositoryService)({
              cloneRepository: () =>
                success({
                  cwd: "/projects/synthetic",
                  remoteUrl: "https://example.test/repo.git",
                  repository: null,
                }),
            }),
          ),
          Layer.provide(
            Layer.mock(ProjectService.ProjectService)({
              create: () =>
                success({
                  id: "created",
                  title: "Synthetic",
                  workspaceRoot: "/projects/synthetic",
                  scripts: [],
                  defaultModelSelection: null,
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                  deletedAt: null,
                } as never),
            }),
          ),
          Layer.provide(
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: "/projects",
            }),
          ),
          Layer.provide(
            Layer.mock(ScheduledTasks.ScheduledTaskService)({
              list: () =>
                Effect.succeed({
                  tasks: [
                    {
                      id: "task:synthetic-private",
                      runtimeMode: "auto",
                      interactionMode: "default",
                      threadId: null,
                    },
                  ],
                } as never),
              runNow: () =>
                success({
                  task: {
                    id: "task:synthetic-private",
                    lastRunStatus: "running",
                    runCount: 1,
                    nextRunAt: null,
                  },
                  threadId: null,
                } as never),
            }),
          ),
        ),
      ),
    );
    expect(result.isError === true).toBe(outcome !== "success");
    expect(events).toEqual([
      {
        event: "feature.used",
        properties: {
          feature: "auto-environment-tools",
          action,
          source: "agent",
          durationMs: 0,
          outcome: outcome === "refused" ? "failure" : outcome,
          ...(outcome === "success"
            ? {}
            : { failureReason: outcome === "refused" ? "refused" : "operation_failed" }),
        },
      },
    ]);
  }),
);
