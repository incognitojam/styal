import type {
  ClientOs,
  ClientSurface,
  DeviceActionType,
  DevicePlatform,
  HardwareTier,
  PreviewAutomationOperation,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import * as AnalyticsService from "./AnalyticsService.ts";

// Extend this union at the feature's entry point. Never pass tool arguments or
// results: usage properties are a fixed vocabulary, independent of user data.
type FeatureUsage =
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
      readonly feature: "workflow-run-watch";
      readonly action: "watch" | "unwatch";
      readonly source: "agent";
    };

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

function deviceFailureReason(cause: Cause.Cause<unknown>) {
  const error = Cause.findErrorOption(cause);
  const tag =
    Option.isSome(error) &&
    typeof error.value === "object" &&
    error.value !== null &&
    "_tag" in error.value
      ? error.value._tag
      : undefined;
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
 * `watchResult` reads the category of a successful workflow run watch call from its result.
 */
export const observe = <A, E, R>(
  usage: FeatureUsage,
  effect: Effect.Effect<A, E, R>,
  client: ClientDimensions = {},
  watchResult?: (value: A) => WorkflowRunWatchResult,
) =>
  Effect.gen(function* () {
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
            ...(usage.feature === "devices" &&
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
            ...(watchResult !== undefined && Exit.isSuccess(exit)
              ? { watchResult: watchResult(exit.value) }
              : {}),
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
