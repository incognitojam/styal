import type { PullRequestCheck, SourceControlProviderKind } from "@t3tools/contracts";

import type { GitHubActionsLogPresentation } from "~/terminal/terminalOutputPresentation";

export interface GitHubActionsJobTarget {
  readonly hostname: string;
  readonly repository: string;
  readonly repositoryRef: string;
  readonly runId: string;
  readonly jobId: string;
}

export type PullRequestCheckOpenPlan =
  | {
      readonly kind: "terminal";
      readonly command: string;
      readonly presentation: GitHubActionsLogPresentation;
    }
  | { readonly kind: "external"; readonly url: string };

const SAFE_REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/u;
const SAFE_HOST = /^[A-Za-z0-9.-]+$/u;
const NUMERIC_ID = /^\d+$/u;

/** Only Actions job links contain everything `gh` needs without another provider-shaped read. */
export function parseGitHubActionsJobUrl(rawUrl: string): GitHubActionsJobTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !SAFE_HOST.test(url.hostname)) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  const [owner, repository, actions, runs, runId, job, jobId] = parts;
  if (
    parts.length < 7 ||
    !owner ||
    !repository ||
    actions !== "actions" ||
    runs !== "runs" ||
    job !== "job" ||
    !runId ||
    !jobId ||
    !SAFE_REPOSITORY_PART.test(owner) ||
    !SAFE_REPOSITORY_PART.test(repository) ||
    !NUMERIC_ID.test(runId) ||
    !NUMERIC_ID.test(jobId)
  ) {
    return null;
  }

  return {
    hostname: url.hostname,
    repository: `${owner}/${repository}`,
    repositoryRef:
      url.hostname === "github.com"
        ? `${owner}/${repository}`
        : `${url.hostname}/${owner}/${repository}`,
    runId,
    jobId,
  };
}

export function resolvePullRequestCheckOpenPlan(
  provider: SourceControlProviderKind,
  check: PullRequestCheck,
): PullRequestCheckOpenPlan | null {
  if (check.url === null) return null;
  if (provider !== "github") return { kind: "external", url: check.url };

  const target = parseGitHubActionsJobUrl(check.url);
  if (target === null) return { kind: "external", url: check.url };

  const hostArgument = target.hostname === "github.com" ? "" : ` --hostname ${target.hostname}`;
  const viewLog = `gh api --allow-escape-sequences${hostArgument} repos/${target.repository}/actions/jobs/${target.jobId}/logs`;
  const command =
    check.status === "pending"
      ? `gh run watch ${target.runId} --compact -R ${target.repositoryRef}; ${viewLog}`
      : viewLog;
  return {
    kind: "terminal",
    // The job-log endpoint is available as soon as this job settles, even while sibling jobs run.
    // A pending job has no downloadable log yet, so keep the existing honest status view first.
    command,
    presentation: {
      kind: "github-actions-log",
      title: check.name,
      command,
    },
  };
}
