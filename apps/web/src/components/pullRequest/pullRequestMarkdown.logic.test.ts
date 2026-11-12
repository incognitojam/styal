import { changeRequestReferenceAutolinker } from "@t3tools/client-runtime/pull-request-markdown";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import {
  pullRequestCommentPreview,
  pullRequestRelativeImagePath,
  remarkPullRequestAutolinks,
} from "./pullRequestMarkdown.logic";

type Node = {
  type: string;
  value?: string;
  url?: string;
  data?: { hProperties?: Record<string, unknown> };
  children?: Node[];
};

function links(markdown: string) {
  const autolinks = changeRequestReferenceAutolinker({
    provider: "github",
    url: "https://github.com/team/repo/pull/8",
  })!;
  const tree = unified().use(remarkParse).parse(markdown) as Node;
  remarkPullRequestAutolinks({ autolinks })(tree as never);
  const found: Array<[string | undefined, string | undefined, unknown]> = [];
  const visit = (node: Node) => {
    if (node.type === "link") {
      found.push([
        node.children?.[0]?.value,
        node.url,
        node.data?.hProperties?.["dataPullRequestAutolink"],
      ]);
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return found;
}

describe("remarkPullRequestAutolinks", () => {
  it("links the host's references in prose and leaves links and code alone", () => {
    expect(links("Fixes #12 in **abcdef1**. [#13](https://example.com) `#14`")).toEqual([
      ["#12", "https://github.com/team/repo/issues/12", "reference"],
      ["abcdef1", "https://github.com/team/repo/commit/abcdef1", "commit"],
      ["#13", "https://example.com", undefined],
    ]);
  });
});

describe("pull request relative images", () => {
  it("reads a relative image as a repository path", () => {
    expect(pullRequestRelativeImagePath("./docs/screenshot.png", "github")).toBe(
      "docs/screenshot.png",
    );
    expect(pullRequestRelativeImagePath("docs/hello%20world.png?raw=1#frag", "github")).toBe(
      "docs/hello world.png",
    );
  });

  it("leaves qualified URLs to the default resolution", () => {
    for (const source of [
      "https://github.com/acme/web/blob/feature/docs/screenshot.png",
      "https://raw.githubusercontent.com/acme/web/assets/pr-7/screenshot.png",
      "https://github.com/user-attachments/assets/0f0e0d0c-1111-2222-3333-444455556666",
      "https://example.com/screenshot.png",
      "//example.com/screenshot.png",
      "/acme/web/raw/main/screenshot.png",
      "data:image/png;base64,AAAA",
    ]) {
      expect(pullRequestRelativeImagePath(source, "github")).toBeNull();
    }
  });

  it("rejects paths that leave the repository and other providers", () => {
    expect(pullRequestRelativeImagePath("../secret.png", "github")).toBeNull();
    expect(pullRequestRelativeImagePath("docs/%2e%2e/%2e%2e/secret.png", "github")).toBeNull();
    expect(pullRequestRelativeImagePath("docs\\screenshot.png", "github")).toBeNull();
    expect(pullRequestRelativeImagePath("docs/screenshot.png", "gitlab")).toBeNull();
  });
});

describe("pullRequestCommentPreview", () => {
  it.each([
    ["<!-- hidden -->\n> [!WARNING]\n**Guard** [this](https://example.com).", "Guard this."],
    [
      '<a href="https://example.com"><img src="badge.svg" /></a>\n<strong>Tasks keep the wrong computer</strong>',
      "Tasks keep the wrong computer",
    ],
    [
      "<details><summary>Review &amp; fixes</summary><p>First<br>Second</p></details>",
      "Review & fixes First Second",
    ],
    ['<p title="value > limit">Keep <strong>this</strong> readable.</p>', "Keep this readable."],
    [
      "Use `<div>` and `Promise<void>`.\n\n```html\n<span>example</span>\n```",
      "Use <div> and Promise<void>. <span>example</span>",
    ],
    ["![badge](https://example.com/badge.svg) **Review**", "badge Review"],
    ["```md\n[!TIP]\n> [!WARNING]\n```\n\n    [!NOTE]", "[!TIP] > [!WARNING] [!NOTE]"],
    [
      "Review :codex-file-citation{purpose='output'} safely.",
      "Review :codex-file-citation{purpose='output'} safely.",
    ],
    [":codex-followup[Prepare **print** version]", ":codex-followup[Prepare **print** version]"],
  ])("extracts readable text from %s", (body, expected) => {
    expect(pullRequestCommentPreview(body)).toBe(expected);
  });
});
