import { type OrchestrationV2Command, WS_METHODS } from "@t3tools/contracts";
import type {
  ClientOs,
  ClientSurface,
  DeviceActionType,
  DevicePlatform,
  HardwareTier,
  PreviewAutomationOperation,
  SimulatorMemoryMode,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import * as AnalyticsService from "./AnalyticsService.ts";

export interface FeatureUsage {
  readonly feature: string;
  readonly variant?: string;
}

type Payload = Readonly<Record<string, unknown>>;

const literal = (payload: Payload, key: string) =>
  typeof payload[key] === "string" ? (payload[key] as string) : undefined;

const use = (feature: string, variant?: string): FeatureUsage =>
  variant === undefined ? { feature } : { feature, variant };

/**
 * User commands sent through `orchestration.dispatchCommand` that represent a
 * feature choice. Housekeeping commands (visits, reorders, acknowledgements)
 * and `message.dispatch`, which `client.turn.requested` already counts, are
 * left out. The dispatch handler records these, not the RPC middleware, so a
 * retried command id that changed nothing is not counted again.
 */
const COMMAND_FEATURES: {
  readonly [Type in OrchestrationV2Command["type"]]?: (
    command: Extract<OrchestrationV2Command, { readonly type: Type }>,
  ) => FeatureUsage;
} = {
  "checkpoint.rollback": (command) => ({
    feature: "checkpoint.rollback",
    variant: command.restoreFiles === false ? "conversation_only" : "with_files",
  }),
  "thread.fork": () => ({ feature: "thread.fork" }),
  "thread.merge_back": () => ({ feature: "thread.merge_back" }),
  "provider.switch": () => ({ feature: "provider.switch" }),
  "thread.archive": () => ({ feature: "thread.archive" }),
  "thread.snooze": () => ({ feature: "thread.snooze" }),
  "thread.pin": () => ({ feature: "thread.pin" }),
  "thread.settle": () => ({ feature: "thread.settle" }),
  "thread.pull-request.link": () => ({ feature: "thread.pull_request.link" }),
  "thread.pull-request.watch": (command) =>
    use("thread.pull_request.watch", command.watching ? "on" : "off"),
  "thread.runtime-mode.set": (command) => use("thread.runtime_mode.set", command.runtimeMode),
  "thread.interaction-mode.set": (command) =>
    use("thread.interaction_mode.set", command.interactionMode),
  "run.interrupt": () => ({ feature: "run.interrupt" }),
  // Clients stop a thread without naming a run once the server supports it; count it as the same Stop.
  "thread.stop": () => ({ feature: "run.interrupt" }),
  "queued-message.promote-to-steer": () => ({ feature: "queue.steer" }),
  "queued-run.edit": () => ({ feature: "queue.edit" }),
};

/**
 * RPCs that represent a user starting a feature. Variants come only from
 * closed enums in the contracts, so no path, id, or free text can reach analytics.
 * Thread launches are left out because `client.thread.started` counts them.
 */
const METHOD_FEATURES: Readonly<Record<string, (payload: Payload) => FeatureUsage>> = {
  [WS_METHODS.terminalOpen]: () => ({ feature: "terminal.open" }),
  [WS_METHODS.previewOpen]: () => ({ feature: "preview.open" }),
  [WS_METHODS.deviceOpen]: () => ({ feature: "device.open" }),
  [WS_METHODS.shellOpenInEditor]: (payload) => use("editor.open", literal(payload, "editor")),
  [WS_METHODS.vcsCreateWorktree]: () => ({ feature: "worktree.create" }),
  [WS_METHODS.gitRunStackedAction]: (payload) =>
    use("git.stacked_action", literal(payload, "action")),
  [WS_METHODS.pullRequestsRunAction]: (payload) =>
    use("pull_request.action", literal(payload, "action")),
  [WS_METHODS.pullRequestsSubmitReview]: () => ({ feature: "pull_request.review" }),
  [WS_METHODS.pullRequestsComment]: () => ({ feature: "pull_request.comment" }),
  [WS_METHODS.scheduledTasksUpsert]: () => ({ feature: "scheduled_task.save" }),
  [WS_METHODS.scheduledTasksRunNow]: () => ({ feature: "scheduled_task.run_now" }),
  [WS_METHODS.agentSessionsImport]: () => ({ feature: "agent_session.import" }),
  [WS_METHODS.projectCloneStart]: () => ({ feature: "project.clone" }),
  [WS_METHODS.sourceControlPublishRepository]: () => ({ feature: "repository.publish" }),
  [WS_METHODS.serverUpsertKeybinding]: () => ({ feature: "keybinding.customize" }),
};

/**
 * Requests the fork already reports under its own events: Device panel opens and
 * workflow approvals as `devices` and `workflow-approvals` feature usage with outcomes,
 * and thread settles and archives as `client.thread.settled` and `client.thread.archived`.
 * Counting them here as well would report one action twice.
 */
const methodReportedByForkEvents = (method: string, input: Payload) =>
  method === WS_METHODS.deviceOpen ||
  (method === WS_METHODS.pullRequestsRunAction && input.action === "approve-workflows");

const commandReportedByForkEvents = (command: OrchestrationV2Command) =>
  command.type === "thread.settle" || command.type === "thread.archive";

/** The feature a dispatched command uses, or undefined when it is not a tracked feature. */
export function commandFeatureUsage(command: OrchestrationV2Command): FeatureUsage | undefined {
  if (commandReportedByForkEvents(command)) return undefined;
  // TypeScript cannot pair a union's tag with its own entry, so widen once here.
  const mapping = COMMAND_FEATURES[command.type] as
    | ((command: OrchestrationV2Command) => FeatureUsage)
    | undefined;
  return mapping?.(command);
}

/** The feature a WebSocket request uses, or undefined when it is not a tracked feature. */
export function featureUsage(method: string, payload: unknown): FeatureUsage | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const input = payload as Payload;
  if (methodReportedByForkEvents(method, input)) return undefined;
  return METHOD_FEATURES[method]?.(input);
}

// Extend this union at the feature's entry point. Never pass tool arguments or
// results: usage properties are a fixed vocabulary, independent of user data.
type ObservedUsage =
  | {
      readonly feature: "browser-tools";
      readonly action: PreviewAutomationOperation;
      readonly source: "agent";
    }
  | {
      readonly feature: "devices";
      readonly action: "list" | "open" | "close" | "shutdown" | "snapshot" | DeviceActionType;
      readonly source: "user" | "agent";
      readonly devicePlatform?: DevicePlatform | undefined;
      readonly deviceLocation?: "local" | "remote" | undefined;
    }
  | {
      readonly feature: "simulator-memory";
      readonly action: "prepare";
      readonly source: "system";
      readonly memoryMode: SimulatorMemoryMode;
    }
  | {
      readonly feature: "hardware";
      readonly action:
        | "list"
        | "acquire"
        | "call"
        | "release"
        | "revoke"
        | "pause"
        | "resume"
        | "keep"
        | "accept_definition"
        | "set_credential";
      readonly source: "user" | "agent";
      /** For `call`: the action's tier, never its name or arguments. */
      readonly hardwareTier?: HardwareTier | undefined;
    }
  | {
      readonly feature: "project-file-approvals";
      readonly action: "review" | "approve" | "revoke";
      readonly source: "user";
    }
  | {
      readonly feature: "workflow-approvals";
      readonly action: "approve";
      readonly source: "user";
    }
  | {
      readonly feature: "delegated-wake";
      readonly action: "delegate";
      readonly source: "agent";
      readonly wake: "each";
    }
  | {
      readonly feature: "delegated-wake";
      readonly action: "delegate";
      readonly source: "agent";
      readonly wake: "all";
      readonly wakeAfter: boolean;
    }
  | {
      readonly feature: "workflow-run-watch";
      readonly action: "watch" | "unwatch";
      readonly source: "agent";
    }
  | {
      readonly feature: "workflow-run-watch";
      readonly action: "review";
      readonly source: "user";
      readonly reviewState: "approved" | "rejected";
    };

/**
 * Agent tools that report each call as `feature.used` with the fork's vocabulary and
 * outcomes. Every tool in the browser, device and hardware toolkits is observed, so
 * upstream's generic `mcp.tool.invoked` skips them to report each call once.
 */
export const toolReportedAsFeatureUsage = (tool: string) =>
  tool.startsWith("preview_") ||
  tool.startsWith("device_") ||
  tool.startsWith("hardware_") ||
  tool === "watch_workflow_run" ||
  tool === "unwatch_workflow_run";

/** What a successful watch_workflow_run or unwatch_workflow_run call did. */
export type WorkflowRunWatchResult =
  | "started"
  | "already_watching"
  | "already_completed"
  | "stopped"
  | "not_watching";

export interface ClientDimensions {
  readonly surface?: ClientSurface | undefined;
  readonly clientOs?: ClientOs | undefined;
  readonly clientAppVersion?: string | undefined;
}

/** Boot limits, killed helper commands and peers that stop answering. */
function isDeviceTimeout(error: object) {
  if (!("_tag" in error)) return false;
  const cause = "cause" in error ? error.cause : undefined;
  switch (error._tag) {
    case "DeviceBootError":
      return "reason" in error && error.reason === "timeout";
    case "DeviceOperationError":
      return ("exitCode" in error && error.exitCode === 124) || Cause.isTimeoutError(cause);
    case "DeviceHostUnavailableError":
      return typeof cause === "object" && cause !== null && "timedOut" in cause;
    default:
      return false;
  }
}

function deviceFailureReason(cause: Cause.Cause<unknown>) {
  const error = Cause.findErrorOption(cause);
  const failure =
    Option.isSome(error) && typeof error.value === "object" && error.value !== null
      ? error.value
      : undefined;
  if (failure !== undefined && isDeviceTimeout(failure)) return "timeout";
  const tag = failure !== undefined && "_tag" in failure ? failure._tag : undefined;
  switch (tag) {
    case "DeviceToolUnavailableError":
    case "DeviceHostUnavailableError":
    case "DevicePlatformUnavailableError":
      return "unavailable";
    case "DeviceNotFoundError":
      return "not_found";
    // Another thread is using the device; a contested device, not a broken one.
    case "DeviceHeldError":
      return "in_use";
    default:
      return "operation_failed";
  }
}

/** Bounded categories; contention and the user's own refusals are not broken operations. */
function hardwareFailureReason(cause: Cause.Cause<unknown>) {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  const failure = typeof error === "object" && error !== null ? error : undefined;
  const tag = failure !== undefined && "_tag" in failure ? failure._tag : undefined;
  if (tag === "OrchestratorMcpFailure") return "refused";
  if (tag !== "HardwareToolError" || failure === undefined || !("code" in failure)) {
    return "operation_failed";
  }
  switch (failure.code) {
    case "busy":
      return "in_use";
    case "offline":
    case "request_failed":
      return "device_unreachable";
    case "approval_declined":
      return "declined";
    case "approval_timeout":
      return "approval_timeout";
    case "not_held":
    case "paused":
    case "forbidden":
      return "refused";
    case "not_found":
    case "invalid_request":
      return "invalid_request";
    case "unavailable":
      return "unavailable";
    default:
      return "operation_failed";
  }
}

/** The approval service's own refusals, so a stale review is not counted as broken. */
function projectFileApprovalFailureReason(cause: Cause.Cause<unknown>) {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  const failure = typeof error === "object" && error !== null ? error : undefined;
  if (failure === undefined || !("_tag" in failure)) return "operation_failed";
  if (failure._tag === "EnvironmentAuthorizationError") return "refused";
  if (failure._tag !== "ProjectFileActionApprovalError" || !("reason" in failure)) {
    return "operation_failed";
  }
  switch (failure.reason) {
    case "project-not-found":
    case "action-not-found":
      return "not_found";
    case "nothing-to-approve":
      return "invalid_request";
    default:
      return "operation_failed";
  }
}

function workflowRunWatchFailureReason(cause: Cause.Cause<unknown>) {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  const failure = typeof error === "object" && error !== null ? error : undefined;
  switch (failure !== undefined && "_tag" in failure ? failure._tag : undefined) {
    // Access checks fail this way before the tool runs; orchestration_error is an internal failure.
    case "OrchestratorMcpFailure":
      return failure !== undefined && "code" in failure && failure.code === "orchestration_error"
        ? "operation_failed"
        : "refused";
    case "WorkflowRunReadFailedError":
      return "read_failed";
    case "WorkflowRunUrlInvalidError":
    case "WorkflowRunTargetIncompleteError":
    case "PullRequestHostRequiredError":
      return "invalid_target";
    case "McpCapabilityUnavailableError":
      return "unavailable";
    case "PullRequestWatchFromSubagentError":
    case "WorkflowRunWatchFailedError":
      return "refused";
    default:
      return "operation_failed";
  }
}

/**
 * Observe one public operation, preserving its result, failure and interruption.
 * `resultProperties` reads bounded categories from a successful result. Untraced:
 * the observed operation owns the span, and this only records usage around it.
 */
export const observe = Effect.fnUntraced(function* <A, E, R>(
  usage: ObservedUsage,
  effect: Effect.Effect<A, E, R>,
  client: ClientDimensions = {},
  resultProperties?: (value: A) => Readonly<Record<string, string>>,
) {
  const analytics = yield* AnalyticsService.AnalyticsService;
  const startedAt = yield* Clock.currentTimeMillis;
  return yield* effect.pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        const finishedAt = yield* Clock.currentTimeMillis;
        yield* analytics.record("feature.used", {
          feature: usage.feature,
          action: usage.action,
          source: usage.source,
          ...((usage.feature === "devices" || usage.feature === "simulator-memory") &&
          Exit.isFailure(exit) &&
          !Cause.hasInterruptsOnly(exit.cause)
            ? { failureReason: deviceFailureReason(exit.cause) }
            : {}),
          ...(usage.feature === "workflow-run-watch" &&
          Exit.isFailure(exit) &&
          !Cause.hasInterruptsOnly(exit.cause)
            ? { failureReason: workflowRunWatchFailureReason(exit.cause) }
            : {}),
          ...(usage.feature === "hardware" &&
          Exit.isFailure(exit) &&
          !Cause.hasInterruptsOnly(exit.cause)
            ? { failureReason: hardwareFailureReason(exit.cause) }
            : {}),
          ...(usage.feature === "project-file-approvals" &&
          Exit.isFailure(exit) &&
          !Cause.hasInterruptsOnly(exit.cause)
            ? { failureReason: projectFileApprovalFailureReason(exit.cause) }
            : {}),
          ...(usage.feature === "hardware" && usage.hardwareTier
            ? { hardwareTier: usage.hardwareTier }
            : {}),
          ...(usage.feature === "delegated-wake"
            ? { wake: usage.wake, ...(usage.wake === "all" ? { wakeAfter: usage.wakeAfter } : {}) }
            : {}),
          ...(usage.feature === "workflow-run-watch" && usage.action === "review"
            ? { reviewState: usage.reviewState }
            : {}),
          ...(resultProperties !== undefined && Exit.isSuccess(exit)
            ? resultProperties(exit.value)
            : {}),
          ...(usage.feature === "simulator-memory" ? { memoryMode: usage.memoryMode } : {}),
          ...(usage.feature === "devices"
            ? {
                ...(usage.devicePlatform ? { devicePlatform: usage.devicePlatform } : {}),
                ...(usage.deviceLocation ? { deviceLocation: usage.deviceLocation } : {}),
              }
            : {}),
          ...(client.surface ? { surface: client.surface } : {}),
          ...(client.clientOs ? { clientOs: client.clientOs } : {}),
          ...(client.clientAppVersion ? { clientAppVersion: client.clientAppVersion } : {}),
          outcome: Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "cancelled"
              : "failure",
          durationMs: Math.max(0, finishedAt - startedAt),
        });
      }).pipe(Effect.ignoreCause),
    ),
  );
});
