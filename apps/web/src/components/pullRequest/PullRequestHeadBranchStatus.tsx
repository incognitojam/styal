import type { EnvironmentId, PullRequestDetail } from "@t3tools/contracts";
import { pullRequestHeadBranchStatus } from "@t3tools/client-runtime/pull-request-branch";
import { CircleHelpIcon, GitBranchIcon, Trash2Icon } from "lucide-react";
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
  const Icon =
    detail.headBranchState === "deleted"
      ? Trash2Icon
      : detail.headBranchState === "present"
        ? GitBranchIcon
        : CircleHelpIcon;
  return (
    <span
      role="status"
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-sans text-xs text-muted-foreground"
    >
      <Icon aria-hidden className="size-3" />
      {label}
    </span>
  );
}
