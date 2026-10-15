import type { GitHubReference } from "./sourceControlProvider.graphql.ts";

export interface GitHubReferenceRequest {
  readonly repository: string;
  readonly number: number;
}

export interface GitHubResolvedReference {
  readonly repository: string;
  readonly number: number;
  /** Null when the host has nothing under this number. */
  readonly kind: "issue" | "pull-request" | null;
  readonly title: string | null;
  readonly state: "open" | "draft" | "closed" | "merged" | null;
  readonly url: string | null;
}

/** GitHub scores a query before running it. A body citing more than this is quoting a changelog. */
export const MAX_REFERENCES_PER_REQUEST = 40;

/** `owner/repo`, split the way the host addresses it. */
export function splitRepository(repository: string): { owner: string; name: string } | null {
  const segments = repository.split("/");
  const owner = segments[0]?.trim();
  const name = segments[1]?.trim();
  return segments.length === 2 && owner && name ? { owner, name } : null;
}

/** A null without a NOT_FOUND error is unknown, so it remains an ordinary link. */
export function toGitHubResolvedReference(
  reference: GitHubReferenceRequest,
  result: GitHubReference.Result,
): GitHubResolvedReference | null {
  const node = result.repository?.issueOrPullRequest;
  if (node == null || !("title" in node)) return null;
  const kind = node.__typename === "Issue" ? "issue" : "pull-request";
  const rawState = "pullRequestState" in node ? node.pullRequestState : node.state;
  const state =
    rawState === "MERGED"
      ? "merged"
      : rawState === "CLOSED"
        ? "closed"
        : "isDraft" in node && node.isDraft
          ? "draft"
          : "open";
  return {
    ...reference,
    kind,
    title: node.title.trim() || null,
    url: node.url.trim() || null,
    state,
  };
}

/** Only an explicit NOT_FOUND can say that the requested reference is missing. */
export function missingGitHubReference(reference: GitHubReferenceRequest): GitHubResolvedReference {
  return { ...reference, kind: null, title: null, url: null, state: null };
}
