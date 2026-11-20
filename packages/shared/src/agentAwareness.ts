import {
  isListedThreadLineage,
  type EnvironmentId,
  isProviderNativeSubagentThread,
  type OrchestrationV2ThreadShell,
  type Project,
  type RuntimeRequestId,
  type ServerSettings,
  type ThreadId,
  threadDisplayName,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  backgroundWorkHoldsCompletion,
  monitorHoldsWakeCompletion,
} from "./orchestrationV2PendingBackgroundWork.ts";

export type AgentAwarenessPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";

export interface SubagentRequestAwareness {
  readonly requestId: RuntimeRequestId;
  readonly requestIds?: readonly RuntimeRequestId[];
  /** The child's own update time, which moves whenever its request changes. */
  readonly updatedAt: DateTime.Utc;
}

/** Provider-native subagents ask on their parent; the coordinator answers child questions. */
export function subagentAwaitsApproval(
  thread: Pick<
    OrchestrationV2ThreadShell,
    "activityRunStatus" | "creationSource" | "lineage" | "pendingRuntimeRequest"
  >,
): boolean {
  const kind = thread.pendingRuntimeRequest?.kind;
  return (
    kind !== undefined &&
    kind !== "auth_refresh" &&
    kind !== "user_input" &&
    thread.lineage.relationshipToParent === "subagent" &&
    !isProviderNativeSubagentThread(thread) &&
    // The activity run stays set when a follow-up is queued behind a blocked run.
    thread.activityRunStatus != null
  );
}

export function threadAttentionSubjects(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "pendingRuntimeRequest"
    | "workflowRuns"
    | "openReportQuestionCount"
    | "latestOpenReportQuestionAt"
    | "openReportQuestionIds"
  >,
): readonly string[] {
  return [
    ...(thread.pendingRuntimeRequest && thread.pendingRuntimeRequest.kind !== "auth_refresh"
      ? [thread.pendingRuntimeRequest.id]
      : []),
    ...(thread.workflowRuns ?? [])
      .filter((run) => run.review !== undefined)
      .map((run) => `workflow:${run.host}/${run.repository}#${run.runId}`),
    ...(thread.openReportQuestionIds ??
      ((thread.openReportQuestionCount ?? 0) > 0
        ? [
            thread.latestOpenReportQuestionAt == null
              ? "report"
              : `report:${DateTime.formatIso(thread.latestOpenReportQuestionAt)}`,
          ]
        : [])),
  ].sort();
}

export function hasNewThreadAttention(
  previous: readonly string[],
  next: readonly string[],
): boolean {
  return next.some((id) => !previous.includes(id));
}

export interface AgentAwarenessState {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly phase: AgentAwarenessPhase;
  readonly headline: string;
  readonly detail?: string;
  readonly modelTitle: string;
  readonly updatedAt: string;
  readonly deepLink: string;
  readonly attentionIds?: readonly string[];
}

function buildAgentAwarenessDeepLink(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): string {
  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

export interface ProjectThreadAwarenessV2Input {
  readonly environmentId: EnvironmentId;
  readonly project: Pick<Project, "title">;
  readonly thread: Pick<
    OrchestrationV2ThreadShell,
    | "activityRunStatus"
    | "id"
    | "projectId"
    | "lineage"
    | "latestRunStartedByAgent"
    | "reportTo"
    | "delegatedFrom"
    | "latestRunBackgroundWake"
    | "latestRunStopRequested"
    | "modelSelection"
    | "pendingBackgroundTasks"
    | "pendingRuntimeRequest"
    | "openReportQuestionCount"
    | "openReportQuestionIds"
    | "latestOpenReportQuestionAt"
    | "settledOverride"
    | "status"
    | "title"
    | "updatedAt"
    | "workflowRuns"
  >;
  /** The approval a live subagent below this thread is waiting on. */
  readonly pendingSubagentRequest?: SubagentRequestAwareness | null;
  readonly settings?:
    | Pick<ServerSettings, "projectCoordinatorsEnabled" | "projectCoordinators">
    | undefined;
}

export function projectThreadAwarenessV2(
  input: ProjectThreadAwarenessV2Input,
): AgentAwarenessState | null {
  const { environmentId, project, thread } = input;
  if (!isListedThreadLineage(thread.lineage)) return null;
  const subagentRequest = input.pendingSubagentRequest ?? null;
  const phase = resolveThreadAwarenessPhaseV2(thread, subagentRequest !== null);
  if (phase === null) {
    return null;
  }
  if (phase === "completed" && thread.latestRunStopRequested === true) return null;
  if (
    phase === "completed" &&
    thread.latestRunStartedByAgent === true &&
    (thread.reportTo != null || thread.delegatedFrom != null)
  )
    return null;
  // Resolve the phase first so live or waiting work stays visible after settlement.
  const runStatus = thread.activityRunStatus ?? thread.status;
  if (
    thread.settledOverride === "settled" &&
    (phase === "completed" ||
      phase === "failed" ||
      (phase === "running" && runStatus === "completed")) &&
    !backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
  ) {
    return null;
  }
  const detail =
    phase === "completed"
      ? "Review the completed task."
      : phase === "failed"
        ? "The agent run failed."
        : undefined;
  return {
    environmentId,
    threadId: thread.id,
    projectTitle: project.title,
    threadTitle: threadDisplayName(input.settings, thread, () => project.title),
    phase,
    headline: headlineForPhase(phase),
    ...(detail === undefined ? {} : { detail }),
    modelTitle: thread.modelSelection.model,
    // A child's request leaves the parent's own timestamp alone. Alerts are
    // keyed by phase and time, so a second wait needs the child's time.
    updatedAt: DateTime.formatIso(
      subagentRequest === null
        ? thread.updatedAt
        : DateTime.max(thread.updatedAt, subagentRequest.updatedAt),
    ),
    ...(phase === "waiting_for_input" || phase === "waiting_for_approval"
      ? {
          attentionIds: [
            ...threadAttentionSubjects(thread),
            ...(subagentRequest?.requestIds ??
              (subagentRequest ? [subagentRequest.requestId] : [])),
          ],
        }
      : {}),
    deepLink: buildAgentAwarenessDeepLink({ environmentId, threadId: thread.id }),
  };
}

function resolveThreadAwarenessPhaseV2(
  thread: ProjectThreadAwarenessV2Input["thread"],
  childAwaitsApproval: boolean,
): AgentAwarenessPhase | null {
  if (thread.pendingRuntimeRequest?.kind === "user_input") return "waiting_for_input";
  if (
    (thread.pendingRuntimeRequest !== null &&
      thread.pendingRuntimeRequest.kind !== "auth_refresh") ||
    (thread.workflowRuns ?? []).some((run) => run.review !== undefined)
  ) {
    return "waiting_for_approval";
  }
  // The parent can finish its own turn while a delegated child keeps working,
  // so a child's request outranks the parent's run status.
  if (childAwaitsApproval) return "waiting_for_approval";
  if ((thread.openReportQuestionCount ?? 0) > 0) return "waiting_for_input";
  switch (thread.activityRunStatus ?? thread.status) {
    case "preparing":
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "completed":
      return backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? []) ||
        monitorHoldsWakeCompletion(thread)
        ? "running"
        : "completed";
    case "failed":
      return "failed";
    case "idle":
    case "queued":
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return null;
  }
}

function headlineForPhase(phase: AgentAwarenessPhase): string {
  switch (phase) {
    case "starting":
      return "Starting agent";
    case "running":
      return "Agent is working";
    case "waiting_for_approval":
      return "Approval needed";
    case "waiting_for_input":
      return "Waiting for input";
    case "completed":
      return "Agent finished";
    case "failed":
      return "Agent failed";
    case "stale":
      return "Update delayed";
  }
}
