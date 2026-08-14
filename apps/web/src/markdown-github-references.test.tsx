import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { CHAT_MARKDOWN_SANITIZE_SCHEMA } from "./components/ChatMarkdown";

import {
  collectGithubReferences,
  type GithubReferenceContext,
  remarkGithubReferences,
} from "./markdown-github-references";

const CONTEXT: GithubReferenceContext = { host: "github.com", repository: "pingdotgg/t3code" };

function renderMarkdown(markdown: string, context: GithubReferenceContext | null = CONTEXT) {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm, [remarkGithubReferences, context ?? undefined]]}>
      {markdown}
    </ReactMarkdown>,
  );
}

/** The rules below were each checked against GitHub's own renderer before being written down. */
describe("remarkGithubReferences", () => {
  it("links a bare number to the context repository", () => {
    const html = renderMarkdown("Follow-up to #6587, which introduced it.");

    expect(html).toContain('href="https://github.com/pingdotgg/t3code/issues/6587"');
    expect(html).toContain('data-github-reference="pingdotgg/t3code#6587"');
    expect(html).toContain(">#6587</a>");
    expect(html).toContain("which introduced it.");
  });

  it("links the GH- form in any case, and another repository in full", () => {
    const html = renderMarkdown("See GH-12, gh-13 and pingdotgg/t3code-mobile#14.");

    expect(html).toContain('href="https://github.com/pingdotgg/t3code/issues/12"');
    expect(html).toContain(">GH-12</a>");
    expect(html).toContain(">gh-13</a>");
    expect(html).toContain('href="https://github.com/pingdotgg/t3code-mobile/issues/14"');
    expect(html).toContain(">pingdotgg/t3code-mobile#14</a>");
  });

  it("leaves a number that is part of a word, and one that starts at zero", () => {
    const html = renderMarkdown("foo#123 and #456abc and #0 stay put.");

    expect(html).not.toContain("<a");
    expect(html).toContain("foo#123 and #456abc and #0 stay put.");
  });

  it("links where GitHub links despite the neighbouring punctuation", () => {
    const html = renderMarkdown("(#1), #2. and #3-abc and /#4");

    for (const number of [1, 2, 3, 4]) {
      expect(html).toContain(`href="https://github.com/pingdotgg/t3code/issues/${number}"`);
    }
    expect(html).toContain("-abc");
  });

  it("leaves code spans, code blocks and link labels alone", () => {
    const html = renderMarkdown(
      "`#1` and\n\n```\n#2\n```\n\nand [#3 in a label](https://example.com/page)",
    );

    expect(html).not.toContain("/issues/1");
    expect(html).not.toContain("/issues/2");
    expect(html).not.toContain("/issues/3");
    expect(html).toContain('href="https://example.com/page"');
  });

  it("reads references inside headings, lists, tables and emphasis", () => {
    const html = renderMarkdown("# Fixes #1\n\n- item #2\n\n| a |\n| --- |\n| #3 |\n\n**#4**");

    for (const number of [1, 2, 3, 4]) {
      expect(html).toContain(`href="https://github.com/pingdotgg/t3code/issues/${number}"`);
    }
  });

  it("says a bare pull request or issue URL as the shorthand", () => {
    const html = renderMarkdown(
      "https://github.com/pingdotgg/t3code/pull/6039 and https://github.com/other/repo/issues/7",
    );

    expect(html).toContain(">#6039</a>");
    expect(html).toContain('href="https://github.com/pingdotgg/t3code/pull/6039"');
    expect(html).toContain('data-github-reference="pingdotgg/t3code#6039"');
    expect(html).toContain(">other/repo#7</a>");
  });

  it("names the place a comment or review URL lands, the way GitHub names it", () => {
    const html = renderMarkdown(
      [
        "https://github.com/pingdotgg/t3code/pull/1#issuecomment-2",
        "https://github.com/pingdotgg/t3code/pull/1#discussion_r3",
        "https://github.com/pingdotgg/t3code/pull/1#pullrequestreview-4",
      ].join("\n\n"),
    );

    expect(html.match(/>#1 \(comment\)<\/a>/gu)).toHaveLength(2);
    expect(html).toContain(">#1 (review)</a>");
  });

  it("leaves a deep pull request page, another host, and a written link label", () => {
    const html = renderMarkdown(
      [
        "https://github.com/pingdotgg/t3code/pull/1/files",
        "https://github.com/pingdotgg/t3code/pull/2/commits",
        "https://example.com/pingdotgg/t3code/pull/3",
        "[the fix](https://github.com/pingdotgg/t3code/pull/4)",
      ].join("\n\n"),
    );

    expect(html).toContain(">https://github.com/pingdotgg/t3code/pull/1/files</a>");
    expect(html).toContain(">https://github.com/pingdotgg/t3code/pull/2/commits</a>");
    expect(html).toContain(">https://example.com/pingdotgg/t3code/pull/3</a>");
    expect(html).toContain(">the fix</a>");
    expect(html).not.toContain("data-github-reference");
  });

  it("addresses an Enterprise install at its own host", () => {
    const html = renderMarkdown("#5", { host: "github.acme.test", repository: "team/app" });

    expect(html).toContain('href="https://github.acme.test/team/app/issues/5"');
  });

  it("keeps its marker through the sanitizer the app renders with", () => {
    // Without this the attribute is stripped in production and nothing downstream ever runs,
    // while every test that skips the rehype half keeps passing.
    const html = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkGithubReferences, CONTEXT]]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA]]}
      >
        {"Fixes #6039."}
      </ReactMarkdown>,
    );

    expect(html).toContain('data-github-reference="pingdotgg/t3code#6039"');
    expect(html).toContain('href="https://github.com/pingdotgg/t3code/issues/6039"');
  });

  it("does nothing at all without a repository to read a number against", () => {
    const html = renderMarkdown("Step #2 of #3, see pingdotgg/t3code#4.", null);

    expect(html).not.toContain("<a");
    expect(html).toContain("Step #2 of #3, see pingdotgg/t3code#4.");
  });
});

/**
 * The collector reads the body as text and the plugin reads it as a tree, so they disagree at the
 * edges. Only one direction of disagreement is safe: a rendered reference nobody asked about would
 * never get an answer, while one asked about but never rendered costs a single entry in a batch.
 */
describe("what is asked about covers what is rendered", () => {
  const TRICKY = [
    "Plain #1 and (#2), GH-3, other/repo#4.",
    "In a list:\n\n- item #5\n- https://github.com/pingdotgg/t3code/pull/6\n",
    "Indented code, which mdast keeps and the collector cannot see:\n\n    #7\n",
    "A label [#8 written out](https://example.com/x) and a span `#9`.",
    "| table |\n| --- |\n| #10 |",
    "# Heading #11\n\n> quoted #12",
    "Fenced:\n\n```ts\nconst x = '#13';\n```\n\nafter #14",
    "~~~\n#15\n~~~\n\nand #16",
  ];

  it.each(TRICKY)("covers every rendered reference in %j", (markdown) => {
    const rendered = [
      ...renderMarkdown(markdown).matchAll(/data-github-reference="([^"]+)"/gu),
    ].map((match) => match[1]);
    const asked = new Set(
      collectGithubReferences(CONTEXT, markdown).map(
        (reference) => `${reference.repository.toLowerCase()}#${reference.number}`,
      ),
    );

    for (const key of rendered) {
      expect(asked).toContain(key);
    }
  });
});

describe("collectGithubReferences", () => {
  it("gathers each reference once, from both shorthand and URLs", () => {
    const references = collectGithubReferences(
      CONTEXT,
      "#1 and #1 again, GH-1, other/repo#2, https://github.com/pingdotgg/t3code/pull/3.",
    );

    expect(references).toEqual([
      { repository: "pingdotgg/t3code", number: 1 },
      { repository: "other/repo", number: 2 },
      { repository: "pingdotgg/t3code", number: 3 },
    ]);
  });

  it("does not ask about a reference written as code, which nothing renders as a link", () => {
    const references = collectGithubReferences(
      CONTEXT,
      "Upstream `#123` stays text.\n\n```\n#456\n```\n",
    );

    expect(references).toEqual([]);
  });
});
