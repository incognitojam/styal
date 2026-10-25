import type { PullRequestActivity, PullRequestLifecycleEvent } from "@t3tools/contracts";

export function pullRequestLifecycleEvents(
  activity: Pick<PullRequestActivity, "lifecycleEvents"> & { readonly mergedAt?: string | null },
): ReadonlyArray<PullRequestLifecycleEvent> {
  const events = [
    ...new Map((activity.lifecycleEvents ?? []).map((event) => [event.id, event])).values(),
  ];
  if (activity.mergedAt && !events.some((event) => event.kind === "merged")) {
    events.push({
      id: "merged",
      kind: "merged",
      createdAt: activity.mergedAt,
      actor: null,
      commit: null,
      targetBranch: null,
    });
  }
  return events;
}

export function pullRequestLifecycleText(event: PullRequestLifecycleEvent) {
  if (event.kind !== "merged") {
    return `${event.kind === "head-ref-deleted" ? "deleted" : "restored"} the${event.branchName ? ` ${event.branchName}` : ""} branch`;
  }
  return `${event.commit ? `merged commit ${event.commit.oid.slice(0, 7)}` : event.actor || event.targetBranch ? "merged" : "Pull request merged"}${event.targetBranch ? ` into ${event.targetBranch}` : ""}`;
}
