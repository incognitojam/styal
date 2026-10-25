import type {
  PullRequestChecksState,
  PullRequestDetail,
  PullRequestMergeCommit,
} from "@t3tools/contracts";

/** Undefined hides unsupported hosts; null keeps an unavailable GitHub result visible. */
export function mergedPullRequestCommit(
  pr: Pick<PullRequestDetail, "state" | "provider" | "mergeCommit">,
) {
  if (pr.state !== "merged") return undefined;
  return pr.provider === "github" || pr.mergeCommit !== undefined
    ? (pr.mergeCommit ?? null)
    : undefined;
}

export function mergeCommitChecksSummary(commit: PullRequestMergeCommit | null): {
  label: string;
  state: PullRequestChecksState | null;
} {
  if (commit === null) return { label: "Merge commit unavailable", state: null };
  const checks = commit.checks;
  if (checks === null) return { label: "Checks unavailable", state: null };
  if (checks.length === 0) return { label: "No checks reported", state: null };
  const counts = {
    failed: checks.filter((check) => check.status === "failure").length,
    cancelled: checks.filter((check) => check.status === "cancelled").length,
    pending: checks.filter((check) => check.status === "pending" || check.status === "expected")
      .length,
    "action required": checks.filter((check) => check.status === "action-required").length,
    passed: checks.filter((check) => check.status === "success").length,
    skipped: checks.filter((check) => check.status === "skipped").length,
    neutral: checks.filter((check) => check.status === "neutral").length,
  };
  return {
    label: Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${count} ${count === 1 ? "check" : "checks"} ${status}`)
      .join(", "),
    state:
      counts.failed || counts.cancelled
        ? "failing"
        : counts.pending || counts["action required"]
          ? "pending"
          : counts.passed
            ? "passing"
            : null,
  };
}
