import type { PullRequestDeployment, PullRequestDeploymentStatus } from "@t3tools/contracts";

/** Rows shown before "Show all", so a PR with a preview per service does not bury the description. */
export const PULL_REQUEST_DEPLOYMENT_PAGE = 5;

const STATUS_RANK: Record<PullRequestDeploymentStatus, number> = {
  failure: 0,
  error: 0,
  "in-progress": 1,
  queued: 1,
  pending: 1,
  waiting: 1,
  success: 2,
  unknown: 3,
  inactive: 4,
};

/** Failures first, then running, then deployed, then inactive; the host's order within each. */
export function orderPullRequestDeployments(
  deployments: ReadonlyArray<PullRequestDeployment>,
): PullRequestDeployment[] {
  return deployments
    .map((deployment, index) => ({ deployment, index }))
    .toSorted(
      (a, b) =>
        STATUS_RANK[a.deployment.status] - STATUS_RANK[b.deployment.status] || a.index - b.index,
    )
    .map(({ deployment }) => deployment);
}

export function isFailedPullRequestDeployment(deployment: PullRequestDeployment): boolean {
  return deployment.status === "failure" || deployment.status === "error";
}

/** The section heading, naming failures before anything still deploying. */
export function pullRequestDeploymentsTitle(
  deployments: ReadonlyArray<PullRequestDeployment>,
): string {
  const failed = deployments.filter(isFailedPullRequestDeployment).length;
  const running = deployments.filter((deployment) => STATUS_RANK[deployment.status] === 1).length;
  const detail = failed > 0 ? ` · ${failed} failed` : running > 0 ? ` · ${running} deploying` : "";
  return `Deployments (${deployments.length})${detail}`;
}
