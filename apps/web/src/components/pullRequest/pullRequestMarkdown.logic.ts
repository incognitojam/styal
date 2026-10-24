import type { ReferenceAutolink } from "@t3tools/client-runtime/source-control-clients";

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

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  url?: string;
  data?: unknown;
};

const AUTOLINK_IGNORED_TYPES = new Set(["link", "linkReference"]);

export function remarkPullRequestAutolinks(options: {
  readonly autolinks: (text: string) => ReadonlyArray<ReferenceAutolink>;
}) {
  const visit = (node: MarkdownNode): void => {
    const children = node.children;
    if (children === undefined) return;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      if (AUTOLINK_IGNORED_TYPES.has(child.type)) continue;
      if (child.type !== "text" || child.value === undefined) {
        visit(child);
        continue;
      }
      const value = child.value;
      const links = options.autolinks(value);
      if (links.length === 0) continue;
      const replacements: MarkdownNode[] = [];
      let start = 0;
      for (const link of links) {
        if (start < link.index) {
          replacements.push({ type: "text", value: value.slice(start, link.index) });
        }
        replacements.push({
          type: "link",
          url: link.url,
          data: { hProperties: { dataPullRequestAutolink: link.kind } },
          children: [{ type: "text", value: link.label }],
        });
        start = link.index + link.text.length;
      }
      if (start < value.length) replacements.push({ type: "text", value: value.slice(start) });
      children.splice(index, 1, ...replacements);
      index += replacements.length - 1;
    }
  };
  return (tree: MarkdownNode) => visit(tree);
}
