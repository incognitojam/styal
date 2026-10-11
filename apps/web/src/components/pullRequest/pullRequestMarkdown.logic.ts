import {
  findAndReplaceText,
  type MarkdownNode,
  type TextMatch,
} from "~/vendor/mdast-find-and-replace";

export {
  splitPullRequestBody,
  type PullRequestBodySegment,
} from "@t3tools/client-runtime/pull-request-markdown";

function normalizeRepositoryPath(value: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (decoded.startsWith("/") || decoded.includes("\\")) return null;
  const segments = decoded.split("/").filter((segment) => segment !== "." && segment !== "");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) return null;
  const path = segments.join("/");
  return path.length <= 1_024 ? path : null;
}

/**
 * The repository path a relative image in a GitHub pull request body names. It is read at the
 * pull request head, which the local workspace may not have checked out, so the caller signs it
 * as a pull request file. Qualified URLs return null and keep the default resolution, which
 * fetches GitHub-hosted media with the `gh` credential.
 */
export function pullRequestRelativeImagePath(source: string, provider: string): string | null {
  if (provider !== "github") return null;
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/iu.test(source)) return null;
  return normalizeRepositoryPath(source.split(/[?#]/u, 1)[0] ?? "");
}

const AUTOLINK_CANDIDATE_PATTERN = /#[1-9]\d*|[0-9a-f]{40}/giu;
const AUTOLINK_WORD_CHARACTER_PATTERN = /[A-Za-z0-9_]/u;
const AUTOLINK_COMMIT_PREFIX_PATTERN = /[\s([{]/u;
const AUTOLINK_IGNORED_TYPES = new Set(["link", "linkReference"]);

/** GitHub-style same-repository references for pull request prose, never code or authored links. */
export function remarkPullRequestAutolinks(options: { readonly repositoryUrl: string }) {
  const repositoryUrl = options.repositoryUrl.replace(/\/+$/u, "");
  return (tree: MarkdownNode) => {
    findAndReplaceText(
      tree,
      AUTOLINK_CANDIDATE_PATTERN,
      (matched: string, match: TextMatch) => {
        const reference = matched.startsWith("#");
        const before = match.input[match.index - 1];
        const after = match.input[match.index + matched.length];
        if (
          (before !== undefined &&
            (reference
              ? AUTOLINK_WORD_CHARACTER_PATTERN.test(before)
              : !AUTOLINK_COMMIT_PREFIX_PATTERN.test(before))) ||
          (after !== undefined && AUTOLINK_WORD_CHARACTER_PATTERN.test(after))
        ) {
          return false;
        }
        return {
          type: "link",
          url: reference
            ? `${repositoryUrl}/issues/${matched.slice(1)}`
            : `${repositoryUrl}/commit/${matched}`,
          data: {
            hProperties: {
              dataPullRequestAutolink: reference ? "reference" : "commit",
            },
          },
          children: [{ type: "text", value: reference ? matched : matched.slice(0, 7) }],
        };
      },
      AUTOLINK_IGNORED_TYPES,
    );
  };
}
