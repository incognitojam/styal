import type {
  PullRequestCheck,
  PullRequestChecksState,
  PullRequestMergeability,
  PullRequestMergeReadiness,
  PullRequestState,
} from "@t3tools/contracts";

export function pullRequestChecksState(
  checks: ReadonlyArray<PullRequestCheck>,
): PullRequestChecksState | null {
  if (checks.length === 0) return null;
  const statuses = new Set(checks.map((check) => check.status));
  if (statuses.has("failure") || statuses.has("cancelled")) return "failing";
  if (statuses.has("pending") || statuses.has("expected") || statuses.has("action-required")) {
    return "pending";
  }
  return statuses.has("success") ? "passing" : null;
}

export type PullRequestPrimaryControl =
  | "resolve"
  | "ready"
  | "merge"
  | "enable-auto-merge"
  | "auto-merge-armed"
  | "merged"
  | "closed"
  | null;

export interface PullRequestMergeControlInput {
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  readonly checksState: PullRequestChecksState | null;
  readonly mergeReadiness?: PullRequestMergeReadiness | undefined;
  readonly autoMergeEnabled: boolean | undefined;
  readonly hasMergeMethod: boolean;
  readonly canMerge: boolean;
  readonly canMarkReady: boolean;
  readonly canEnableAutoMerge: boolean;
}

export function resolvePullRequestPrimaryControl(
  input: PullRequestMergeControlInput,
): PullRequestPrimaryControl {
  if (input.state === "merged") return "merged";
  if (input.state === "closed") return "closed";
  if (input.mergeability === "conflicting") return "resolve";
  if (input.isDraft) return input.canMarkReady ? "ready" : null;
  if (input.autoMergeEnabled) return "auto-merge-armed";
  if (!input.hasMergeMethod) return null;
  // Where the host reports merge readiness, its requirements decide between Merge and Auto-merge,
  // and check health stays context: a blocked pull request offers no Merge press the host would
  // refuse.
  if (input.mergeReadiness === "blocked") {
    return input.canEnableAutoMerge ? "enable-auto-merge" : null;
  }
  // GitHub computes readiness in the background and reports UNKNOWN until it has, often just
  // after a push, which is when checks are still running.
  if (
    (input.mergeReadiness === undefined || input.mergeReadiness === "unknown") &&
    input.autoMergeEnabled === false &&
    input.checksState !== null &&
    input.checksState !== "passing" &&
    input.canEnableAutoMerge
  ) {
    return "enable-auto-merge";
  }
  return input.canMerge ? "merge" : null;
}

/**
 * The merge offered beside a primary control that is not Merge. A blocked pull request gets one
 * only when the viewer may bypass the host's requirements, since any other merge is refused.
 */
export function resolvePullRequestMergeNow(
  input: PullRequestMergeControlInput & { readonly canBypassRequirements: boolean },
): "merge" | "bypass" | null {
  if (
    input.state !== "open" ||
    input.isDraft ||
    input.mergeability === "conflicting" ||
    !input.hasMergeMethod ||
    !input.canMerge ||
    resolvePullRequestPrimaryControl(input) === "merge"
  ) {
    return null;
  }
  if (input.mergeReadiness === "blocked") return input.canBypassRequirements ? "bypass" : null;
  return "merge";
}
