import { OrchestratorMcpFailure, type ProjectId, type ThreadId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

/**
 * Fork setting `enableAgentCrossProjectAccess`: when it is off for the calling
 * thread's project, that thread's agent reaches only its own project's
 * threads, projects and scheduled tasks. Settings are read on every call so a
 * change applies to running sessions. A settings read failure refuses the call.
 */
export interface Services {
  readonly threads: ThreadManagement.ThreadManagementService["Service"];
  readonly settings: ServerSettings.ServerSettingsService["Service"];
}

export type Reach = "read" | "write";

export interface CallerReach {
  readonly projectId: ProjectId;
  readonly allowed: boolean;
}

const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The operation could not be completed.",
  });

const refusal = (target: string) =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: `This agent is limited to its own project, and ${target} is outside it. The user can allow other projects with "Agent access to other projects" in the project's settings.`,
  });

/** Undefined for a caller outside a thread, which has no own project to keep to. */
export const callerReach = (
  { threads, settings }: Services,
  scope: McpInvocationScope,
): Effect.Effect<CallerReach | undefined, OrchestratorMcpFailure> => {
  const thread = scope.thread;
  return thread === undefined
    ? Effect.succeed(undefined)
    : Effect.gen(function* () {
        const caller = yield* threads
          .getThreadShell(thread.threadId)
          .pipe(Effect.mapError(unavailable));
        // The access checks refuse a missing caller with their own error.
        if (caller === null) return undefined;
        const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
        return {
          projectId: caller.projectId,
          allowed: resolveProjectSettings(current, caller.projectId).settings
            .enableAgentCrossProjectAccess,
        };
      }).pipe(Effect.withSpan("mcp.agentProjectScope.callerReach"));
};

/** The project an in-thread caller is limited to, or undefined when it may reach every project. */
export const confinedProject = (services: Services, scope: McpInvocationScope) =>
  callerReach(services, scope).pipe(
    Effect.map((caller) => (caller === undefined || caller.allowed ? undefined : caller.projectId)),
  );

/**
 * Analytics is present wherever the MCP toolkits are built, so it is read
 * optionally here instead of being declared by every tool.
 */
const record = (reach: Reach, outcome: "allowed" | "refused") =>
  Effect.serviceOption(AnalyticsService.AnalyticsService).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (analytics) =>
          analytics.record("feature.used", {
            feature: "agent-cross-project",
            action: reach,
            source: "agent",
            outcome,
          }),
      }),
    ),
  );

const decide = (caller: CallerReach, reach: Reach, target: string) =>
  record(reach, caller.allowed ? "allowed" : "refused").pipe(
    Effect.andThen(caller.allowed ? Effect.void : Effect.fail(refusal(target))),
  );

/** Records each reach into another project, and refuses it when the caller's project keeps to itself. */
export const checkTarget = (
  caller: CallerReach | undefined,
  reach: Reach,
  projectId: ProjectId,
  target: string,
) =>
  caller === undefined || caller.projectId === projectId
    ? Effect.void
    : decide(caller, reach, target);

export const assertProject = (
  services: Services,
  scope: McpInvocationScope,
  reach: Reach,
  projectId: ProjectId,
  target = `project ${projectId}`,
) =>
  callerReach(services, scope).pipe(
    Effect.flatMap((caller) => checkTarget(caller, reach, projectId, target)),
  );

/**
 * A missing thread passes, so the tool reports it as not found in its own
 * way rather than as another project's.
 */
export const assertThreads = (
  services: Services,
  scope: McpInvocationScope,
  reach: Reach,
  threadIds: ReadonlyArray<ThreadId | undefined>,
) =>
  Effect.gen(function* () {
    const others = threadIds.filter(
      (threadId): threadId is ThreadId =>
        threadId !== undefined && threadId !== scope.thread?.threadId,
    );
    if (others.length === 0) return;
    const caller = yield* callerReach(services, scope);
    if (caller === undefined) return;
    for (const threadId of others) {
      const target = yield* services.threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError(unavailable));
      if (target !== null && target.deletedAt === null)
        yield* checkTarget(caller, reach, target.projectId, `thread ${threadId}`);
    }
  });

/** The Scratch project is never the caller's own, so every scratch launch reaches outside it. */
export const assertScratchLaunch = (services: Services, scope: McpInvocationScope) =>
  callerReach(services, scope).pipe(
    Effect.flatMap((caller) =>
      caller === undefined ? Effect.void : decide(caller, "write", "the Scratch project"),
    ),
  );

/** For handlers that run with the services in context rather than holding them. */
export const services = Effect.gen(function* () {
  return {
    threads: yield* ThreadManagement.ThreadManagementService,
    settings: yield* ServerSettings.ServerSettingsService,
  } satisfies Services;
});
