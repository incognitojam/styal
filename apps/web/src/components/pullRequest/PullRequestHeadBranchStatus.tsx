import type { EnvironmentId, PullRequestDetail } from "@t3tools/contracts";
import { pullRequestHeadBranchStatus } from "@t3tools/client-runtime/pull-request-branch";
import { useEffect, useRef } from "react";

import { reportForkClientUsage } from "~/forkClientUsage";

export function PullRequestHeadBranchStatus({
  detail,
  environmentId,
}: {
  detail: Pick<PullRequestDetail, "provider" | "headBranchState" | "url">;
  environmentId: EnvironmentId;
}) {
  const label = pullRequestHeadBranchStatus(detail);
  const reported = useRef(new Set<string>());
  useEffect(() => {
    if (label === null) return;
    const key = `${environmentId}:${detail.url}:${detail.headBranchState ?? "unknown"}`;
    if (reported.current.has(key)) return;
    reported.current.add(key);
    void reportForkClientUsage(environmentId, {
      feature: "pull-request-branch-status",
      action: "status_shown",
      branchState: detail.headBranchState ?? "unknown",
    });
  }, [detail.url, detail.headBranchState, environmentId, label]);
  if (label === null) return null;
  return <p className="px-4 pb-3 text-xs text-muted-foreground">Head branch: {label}</p>;
}
