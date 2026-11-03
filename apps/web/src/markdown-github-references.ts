/**
 * GitHub autolinked references are not GFM, so remark leaves them as text. Links use `/issues/{n}`
 * because the host redirects that to `/pull/{n}`. Inert without a context, which keeps `#2` in a
 * chat message plain text.
 */

import {
  formatGithubReference,
  GITHUB_OWNER_PATTERN,
  GITHUB_REPOSITORY_PATTERN,
  type GithubReference,
  type GithubReferenceContext,
  parseGithubReferenceUrl,
} from "@t3tools/client-runtime/github-references";

interface MarkdownAstNode {
  type?: string;
  value?: unknown;
  url?: unknown;
  data?: {
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownAstNode[];
}

/** All three shorthands in one pass, so `owner/repo#123` is found before its bare `#123`. */
const REFERENCE_PATTERN = new RegExp(
  `(?<!\\w)(?:(?<repository>${GITHUB_OWNER_PATTERN}/${GITHUB_REPOSITORY_PATTERN})#|#|GH-)(?<number>[1-9]\\d*)(?!\\w)`,
  "gi",
);

function githubReferenceHref(context: GithubReferenceContext, reference: GithubReference): string {
  return `https://${context.host}/${reference.repository}/issues/${reference.number}`;
}

/** The marker the renderer reads back off the anchor. */
export function formatGithubReferenceKey(reference: GithubReference): string {
  return `${reference.repository.toLowerCase()}#${reference.number}`;
}

function referenceLink(
  context: GithubReferenceContext,
  reference: GithubReference,
  label: string,
  url = githubReferenceHref(context, reference),
): MarkdownAstNode {
  return {
    type: "link",
    url,
    children: [{ type: "text", value: label }],
    data: {
      hProperties: {
        dataGithubReference: formatGithubReferenceKey(reference),
      },
    },
  };
}

function splitTextNode(context: GithubReferenceContext, value: string): MarkdownAstNode[] | null {
  const nodes: MarkdownAstNode[] = [];
  let consumed = 0;
  for (const match of value.matchAll(REFERENCE_PATTERN)) {
    const number = Number(match.groups?.number);
    if (!Number.isSafeInteger(number) || match.index === undefined) continue;
    const repository = match.groups?.repository ?? context.repository;
    if (match.index > consumed) {
      nodes.push({ type: "text", value: value.slice(consumed, match.index) });
    }
    nodes.push(referenceLink(context, { repository, number }, match[0]));
    consumed = match.index + match[0].length;
  }
  if (nodes.length === 0) return null;
  if (consumed < value.length) {
    nodes.push({ type: "text", value: value.slice(consumed) });
  }
  return nodes;
}

/**
 * A bare URL remark-gfm already linkified, relabelled as the shorthand. Only where the link is its
 * own label: `[the fix](…/pull/1)` was written to read that way.
 */
function shortenAutolink(context: GithubReferenceContext, node: MarkdownAstNode): void {
  if (node.type !== "link" || typeof node.url !== "string") return;
  const child = node.children?.length === 1 ? node.children[0] : undefined;
  if (child?.type !== "text" || child.value !== node.url) return;
  const parsed = parseGithubReferenceUrl(context, node.url);
  if (parsed === null) return;
  child.value = `${formatGithubReference(context, parsed.reference)}${parsed.suffix}`;
  node.data = {
    ...node.data,
    hProperties: {
      ...node.data?.hProperties,
      dataGithubReference: formatGithubReferenceKey(parsed.reference),
    },
  };
}

export function remarkGithubReferences(context?: GithubReferenceContext) {
  return (tree: MarkdownAstNode) => {
    if (!context) return;
    const visit = (node: MarkdownAstNode, insideLink: boolean): void => {
      const childInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
      if (!insideLink) shortenAutolink(context, node);
      const children = node.children;
      if (!children) return;
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (!child) continue;
        if (!childInsideLink && child.type === "text" && typeof child.value === "string") {
          const replacement = splitTextNode(context, child.value);
          if (replacement) {
            children.splice(index, 1, ...replacement);
            index += replacement.length - 1;
            continue;
          }
        }
        visit(child, childInsideLink);
      }
    };
    visit(tree, false);
  };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/u;

/**
 * The body with its code removed. Line by line because a fence runs to a closing fence of at least
 * its own length or to the end of the body, which one expression cannot say without saying twice.
 */
function withoutCode(text: string): string {
  let openedBy: string | null = null;
  const prose = text.split("\n").map((line) => {
    const fence = FENCE.exec(line)?.[1];
    if (openedBy === null) {
      if (fence === undefined) return line;
      openedBy = fence;
      return "";
    }
    if (fence !== undefined && fence[0] === openedBy[0] && fence.length >= openedBy.length) {
      openedBy = null;
    }
    return "";
  });
  return prose.join("\n").replace(/(`+)[^`\n]*?\1/gu, "");
}

/**
 * The references a body names, deduplicated, for asking about them at once. Reading the body as
 * text disagrees with the plugin's tree at the edges, so keep the disagreement one-way: collect
 * *at least* what the plugin links, or a rendered reference goes unanswered. A test holds it.
 */
export function collectGithubReferences(
  context: GithubReferenceContext,
  text: string,
): GithubReference[] {
  const prose = withoutCode(text);
  const byKey = new Map<string, GithubReference>();
  for (const match of prose.matchAll(REFERENCE_PATTERN)) {
    const number = Number(match.groups?.number);
    if (!Number.isSafeInteger(number)) continue;
    const reference = { repository: match.groups?.repository ?? context.repository, number };
    byKey.set(formatGithubReferenceKey(reference), reference);
  }
  for (const [url] of prose.matchAll(/https?:\/\/\S+/gu)) {
    // A URL ending a sentence carries its punctuation, which is not part of the URL.
    const parsed = parseGithubReferenceUrl(context, url.replace(/[.,;:!?)\]]+$/u, ""));
    if (parsed) byKey.set(formatGithubReferenceKey(parsed.reference), parsed.reference);
  }
  return [...byKey.values()];
}
