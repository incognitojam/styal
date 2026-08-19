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

export function resolveGitHubStatusNotice(input: unknown): GitHubStatusNotice | null {
  return resolveStatusPageNotice(input, "GitHub");
}
