import * as Contracts from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const projectionCodecs = {
  threads: Contracts.OrchestrationV2AppThreadJson,
  runs: Contracts.OrchestrationV2RunJson,
  run_attempts: Contracts.OrchestrationV2RunAttemptJson,
  nodes: Contracts.OrchestrationV2ExecutionNodeJson,
  provider_sessions: Contracts.OrchestrationV2ProviderSessionJson,
  provider_threads: Contracts.OrchestrationV2ProviderThreadJson,
  provider_turns: Contracts.OrchestrationV2ProviderTurnJson,
  runtime_requests: Contracts.OrchestrationV2RuntimeRequestJson,
  messages: Contracts.OrchestrationV2ConversationMessageJson,
  plans: Contracts.OrchestrationV2PlanArtifact,
  turn_items: Contracts.OrchestrationV2TurnItemJson,
  checkpoint_scopes: Contracts.OrchestrationV2CheckpointScopeJson,
  checkpoints: Contracts.OrchestrationV2CheckpointJson,
  context_handoffs: Contracts.OrchestrationV2ContextHandoffJson,
  context_transfers: Contracts.OrchestrationV2ContextTransferJson,
  subagents: Contracts.OrchestrationV2SubagentJson,
};

export const columnCodecs = {
  "projection_projects.scripts_json": Schema.Array(Contracts.ProjectScript),
  "projection_projects.default_model_selection_json": Contracts.ModelSelection,
  "projection_projects.project_icon_json": Contracts.StoredProjectIcon,
  "projection_thread_pull_requests.snapshot_json": Contracts.ThreadPullRequestSnapshot,
  "projection_thread_pull_requests.stack_json": Contracts.ThreadPullRequestStack,
  "pull_request_review_guides.guide_json": Contracts.PullRequestReviewGuide,
  "projection_threads.model_selection_json": Contracts.ModelSelection,
  "projection_threads.linked_pull_request_json": Contracts.ThreadLinkedPullRequest,
  "projection_threads.branch_pull_request_json": Contracts.ThreadLinkedPullRequest,
  "projection_thread_messages.attachments_json": Schema.Array(Contracts.ChatAttachment),
  "projection_thread_messages.context_json": Contracts.OrchestrationMessageContext,
  "scheduled_tasks.schedule_json": Contracts.ScheduledTaskSchedule,
  "scheduled_tasks.model_selection_json": Contracts.ModelSelection,
  "scheduled_tasks.workspace_strategy_json": Contracts.ScheduledTask.fields.workspaceStrategy,
};

export function schemaKeys(value: unknown, keys = new Set<string>(), seen = new Set<unknown>()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return keys;
  seen.add(value);
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.propertySignatures)) {
    for (const property of record.propertySignatures) {
      if (typeof property.name === "string") keys.add(property.name);
    }
  }
  for (const item of Object.values(record)) {
    if (Array.isArray(item)) item.forEach((child) => schemaKeys(child, keys, seen));
    else schemaKeys(item, keys, seen);
  }
  return keys;
}
