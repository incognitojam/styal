import type { PullRequestDetail } from "@t3tools/contracts";

/** Older servers and hosts that do not report refs must never imply deletion. */
export function pullRequestHeadBranchStatus(
  pr: Pick<PullRequestDetail, "provider" | "headBranchState">,
) {
  if (pr.headBranchState === undefined && pr.provider !== "github") return null;
  switch (pr.headBranchState) {
    case "present":
      return "Branch exists";
    case "deleted":
      return "Branch deleted";
    default:
      return "Unknown";
  }
}
