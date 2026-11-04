import type { RepositoryIdentity } from "@t3tools/contracts";

/** The repository a bare `#123` belongs to, spelled as the repository identity spells it. */
export interface GithubReferenceContext {
  readonly host: string;
  readonly repository: string;
}

export interface GithubReference {
  readonly repository: string;
  readonly number: number;
}

export const GITHUB_OWNER_PATTERN = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
export const GITHUB_REPOSITORY_PATTERN = "[A-Za-z0-9._-]+";

/** An issue or pull request URL and nothing deeper: `/files` and `/commits` are pages. */
const REFERENCE_PATHNAME = new RegExp(
  `^/(?<repository>${GITHUB_OWNER_PATTERN}/${GITHUB_REPOSITORY_PATTERN})/(?:pull|issues)/(?<number>[1-9]\\d*)$`,
  "u",
);

const GITHUB_DOT_COM: GithubReferenceContext = { host: "github.com", repository: "" };

/** The GitHub repository a project's checkout belongs to, if it belongs to one. */
export function githubRepositoryOf(
  identity: RepositoryIdentity | null | undefined,
): GithubReferenceContext | undefined {
  if (identity?.provider !== "github") return undefined;
  const [host, ...path] = identity.canonicalKey.split("/");
  return host && path.length === 2 ? { host, repository: path.join("/") } : undefined;
}

/** How GitHub names a link into an issue: a review's comment is `(comment)`, the review itself is not. */
function fragmentSuffix(fragment: string): string {
  if (fragment.startsWith("#issuecomment-") || fragment.startsWith("#discussion_r")) {
    return " (comment)";
  }
  if (fragment.startsWith("#pullrequestreview-")) return " (review)";
  return "";
}

/** `#123` at home, `owner/repo#123` anywhere else. */
export function formatGithubReference(
  context: GithubReferenceContext,
  reference: GithubReference,
): string {
  const isSameRepository = reference.repository.toLowerCase() === context.repository.toLowerCase();
  return isSameRepository ? `#${reference.number}` : `${reference.repository}#${reference.number}`;
}

/** The reference a URL names, if it names one on this host. */
export function parseGithubReferenceUrl(
  context: GithubReferenceContext,
  targetUrl: string,
): { reference: GithubReference; suffix: string } | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname.toLowerCase() !== context.host.toLowerCase()) return null;
  if (url.search.length > 0) return null;
  const match = REFERENCE_PATHNAME.exec(url.pathname);
  const repository = match?.groups?.repository;
  const number = Number(match?.groups?.number);
  if (!repository || !Number.isSafeInteger(number)) return null;
  return { reference: { repository, number }, suffix: fragmentSuffix(url.hash) };
}

/**
 * The shorthand GitHub shows for a bare issue or pull request URL. Without a repository every
 * reference names its own, and only github.com is recognised.
 */
export function githubReferenceUrlLabel(
  context: GithubReferenceContext | undefined,
  url: string,
): string | null {
  const parsed = parseGithubReferenceUrl(context ?? GITHUB_DOT_COM, url);
  if (parsed === null) return null;
  return `${formatGithubReference(context ?? GITHUB_DOT_COM, parsed.reference)}${parsed.suffix}`;
}
