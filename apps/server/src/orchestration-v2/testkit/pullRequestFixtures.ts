import {
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type PullRequestCheck,
  type PullRequestDetail,
  type RuntimeMode,
  SourceControlProviderKind,
  type ThreadId,
  type ThreadLinkedPullRequest,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface PullRequestTestThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: OrchestrationV2ThreadShell["interactionMode"];
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null;
  readonly branchPullRequest?: ThreadLinkedPullRequest | null;
  readonly latestUserMessageAt: string | null;
  readonly lineage?: OrchestrationV2ThreadShell["lineage"];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly settledOverride: OrchestrationV2ThreadShell["settledOverride"];
  readonly settledAt: string | null;
}

export function v2PullRequestThread(thread: PullRequestTestThread): OrchestrationV2ThreadShell {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    providerInstanceId: thread.modelSelection.instanceId,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    pullRequests: thread.pullRequests,
    linkedPullRequest: thread.linkedPullRequest,
    branchPullRequest: thread.branchPullRequest,
    createdBy: "user",
    creationSource: "web",
    activeProviderThreadId: null,
    lineage: thread.lineage ?? {
      rootThreadId: thread.id,
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: thread.latestUserMessageAt
      ? DateTime.makeUnsafe(thread.latestUserMessageAt)
      : null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: DateTime.makeUnsafe(thread.createdAt),
    updatedAt: DateTime.makeUnsafe(thread.updatedAt),
    archivedAt: thread.archivedAt ? DateTime.makeUnsafe(thread.archivedAt) : null,
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt ? DateTime.makeUnsafe(thread.settledAt) : null,
    deletedAt: null,
  };
}

export const pullRequestDetail = (
  checks: ReadonlyArray<PullRequestCheck>,
  mergeability: "mergeable" | "conflicting" = "mergeable",
  state: PullRequestDetail["state"] = "open",
): PullRequestDetail => ({
  provider: SourceControlProviderKind.make("github"),
  capabilities: {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: false,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
  projectId: ProjectId.make("project-1"),
  projectTitle: "Project",
  workspaceRoot: "/workspace/project",
  repository: "t3tools/t3code",
  number: 9,
  title: "Pull request",
  body: "",
  url: "https://github.com/t3tools/t3code/pull/9",
  author: null,
  state,
  isDraft: false,
  mergeability,
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks,
  mergeCapabilities: { merge: true, squash: true, rebase: true },
});
