import {
  type GithubReferenceContext,
  githubReferenceUrlLabel,
} from "@t3tools/client-runtime/github-references";
import { createContext } from "react";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

type MarkdownNode = {
  readonly type: string;
  readonly url?: string;
  readonly value?: string;
  readonly position?:
    | {
        readonly start: { readonly offset?: number | undefined };
        readonly end: { readonly offset?: number | undefined };
      }
    | undefined;
  readonly children?: readonly MarkdownNode[] | undefined;
};

/** The GitHub repository of the thread a feed shows, which bare URLs into it are labelled against. */
export const ThreadGithubRepositoryContext = createContext<GithubReferenceContext | undefined>(
  undefined,
);

const parser = unified().use(remarkParse).use(remarkGfm);
const GITHUB_REFERENCE_URL_HINT = /\/(?:pull|issues)\/\d/u;

/**
 * Rewrites each bare GitHub issue or pull request URL, or one labelled only `#123`, as a link
 * labelled `#123` or `owner/repo#123`, because the native renderer takes markdown text. A link
 * with any other label keeps it.
 */
export function labelGithubReferenceUrls(
  markdown: string,
  repository: GithubReferenceContext | undefined,
): string {
  if (!GITHUB_REFERENCE_URL_HINT.test(markdown)) return markdown;
  const edits: { start: number; end: number; value: string }[] = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "link") {
      const child = node.children?.length === 1 ? node.children[0] : undefined;
      const url = node.url;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (
        url === undefined ||
        child?.type !== "text" ||
        child.value === undefined ||
        start === undefined ||
        end === undefined ||
        /[\s()<>]/u.test(url)
      ) {
        return;
      }
      const label = githubReferenceUrlLabel(repository, url, child.value);
      if (label !== null) {
        edits.push({ start, end, value: `[${label.replace(/[\\[\]*_`~]/gu, "\\$&")}](${url})` });
      }
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(parser.parse(markdown));
  let labelled = markdown;
  for (let index = edits.length - 1; index >= 0; index--) {
    const edit = edits[index]!;
    labelled = labelled.slice(0, edit.start) + edit.value + labelled.slice(edit.end);
  }
  return labelled;
}
