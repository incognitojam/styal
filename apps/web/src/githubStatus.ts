import {
  resolveStatusPageNotice,
  type StatusPageComponentIssue,
  type StatusPageNotice,
  type StatusPageNoticeTone,
} from "./statusPage";

export const GITHUB_STATUS_PAGE_URL = "https://www.githubstatus.com";
export const GITHUB_STATUS_SUMMARY_URL = `${GITHUB_STATUS_PAGE_URL}/api/v2/summary.json`;

export type GitHubStatusNoticeTone = StatusPageNoticeTone;
export type GitHubStatusComponentIssue = StatusPageComponentIssue;
export type GitHubStatusNotice = StatusPageNotice;

export function hasGitHubProject(
  projects: ReadonlyArray<{
    readonly repositoryIdentity?: { readonly provider?: string | undefined } | null | undefined;
  }>,
): boolean {
  return projects.some((project) => project.repositoryIdentity?.provider === "github");
}

/**
 * Surfaces source-control work can depend on. Copilot is left out: it is a separate product
 * whose disruption says nothing about pushing or reviewing code from here.
 */
export const GITHUB_RELEVANT_COMPONENTS = [
  "Git Operations",
  "API Requests",
  "Pull Requests",
  "Issues",
  "Actions",
  "Webhooks",
  "Packages",
  "Pages",
  "Codespaces",
];

export function resolveGitHubStatusNotice(input: unknown): GitHubStatusNotice | null {
  return resolveStatusPageNotice(input, "GitHub", {
    relevantComponents: GITHUB_RELEVANT_COMPONENTS,
  });
}
