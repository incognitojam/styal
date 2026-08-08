import type { SourceControlIssue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendIssueContextsToPrompt,
  buildIssueContextBlock,
  extractTrailingIssueContexts,
  formatIssueContextLabel,
  type IssueContextSelection,
  issueContextDedupKey,
  newIssueContextId,
  normalizeIssueContextSelection,
} from "./issueContext";
import { deriveDisplayedUserMessageState } from "./terminalContext";

function makeIssue(overrides?: Partial<SourceControlIssue>): SourceControlIssue {
  return {
    provider: "github",
    repository: "pingdotgg/codething-mvp",
    number: 123,
    title: "Fix login crash",
    url: "https://github.com/pingdotgg/codething-mvp/issues/123",
    state: "open",
    author: "octocat",
    body: "Steps to reproduce",
    comments: [{ author: "hubot", body: "Repros here" }],
    ...overrides,
  } as SourceControlIssue;
}

function makeSelection(overrides?: Partial<IssueContextSelection>): IssueContextSelection {
  return {
    ...(normalizeIssueContextSelection(makeIssue()) as IssueContextSelection),
    ...overrides,
  };
}

describe("normalizeIssueContextSelection", () => {
  it("trims strings and normalizes line endings", () => {
    const selection = normalizeIssueContextSelection(
      makeIssue({
        title: "  Fix login crash  ",
        url: "  https://github.com/pingdotgg/codething-mvp/issues/123  ",
        author: "  octocat  ",
        body: "\r\nStep one\r\nStep two\n\n",
        comments: [{ author: "  hubot  ", body: "\n Repros here \n" }],
      }),
    );

    expect(selection).toEqual({
      provider: "github",
      repository: "pingdotgg/codething-mvp",
      number: 123,
      title: "Fix login crash",
      url: "https://github.com/pingdotgg/codething-mvp/issues/123",
      state: "open",
      author: "octocat",
      body: "Step one\nStep two",
      comments: [{ author: "hubot", body: "Repros here" }],
    });
  });

  it("truncates a pathologically large body", () => {
    const selection = normalizeIssueContextSelection(makeIssue({ body: "x".repeat(30_000) }));
    expect(selection?.body.length).toBe(24_000);
    expect(selection?.body.endsWith("…")).toBe(true);
  });

  it("caps the number of retained comments", () => {
    const selection = normalizeIssueContextSelection(
      makeIssue({
        comments: Array.from({ length: 80 }, (_unused, index) => ({
          author: `user-${index}`,
          body: `comment ${index}`,
        })),
      }),
    );
    expect(selection?.comments.length).toBe(50);
  });

  it("returns null when the issue has no usable title or number", () => {
    expect(normalizeIssueContextSelection(makeIssue({ title: "   " }))).toBeNull();
    expect(normalizeIssueContextSelection(makeIssue({ number: 0 }))).toBeNull();
  });

  it("keeps a null repository when the provider did not report one", () => {
    expect(normalizeIssueContextSelection(makeIssue({ repository: null }))?.repository).toBeNull();
  });
});

describe("issueContextDedupKey", () => {
  it("matches the same issue and separates different ones", () => {
    const left = makeSelection();
    expect(issueContextDedupKey(left)).toBe(issueContextDedupKey(makeSelection()));
    expect(issueContextDedupKey(left)).not.toBe(
      issueContextDedupKey(makeSelection({ number: 124 })),
    );
  });
});

describe("formatIssueContextLabel", () => {
  it("renders the issue number and title", () => {
    expect(formatIssueContextLabel(makeSelection())).toBe("#123 Fix login crash");
  });

  it("truncates very long titles", () => {
    const label = formatIssueContextLabel(makeSelection({ title: "y".repeat(200) }));
    expect(label.length).toBe("#123 ".length + 60);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("buildIssueContextBlock", () => {
  it("returns an empty string when there is nothing to serialize", () => {
    expect(buildIssueContextBlock([])).toBe("");
  });

  it("serializes repository, state, author, url, body, and comments", () => {
    expect(buildIssueContextBlock([makeSelection()])).toBe(
      [
        "<issue_context>",
        "- #123 Fix login crash:",
        "  repository: pingdotgg/codething-mvp",
        "  state: open",
        "  author: octocat",
        "  url: https://github.com/pingdotgg/codething-mvp/issues/123",
        "  body:",
        "  Steps to reproduce",
        "  comment by hubot:",
        "  Repros here",
        "</issue_context>",
      ].join("\n"),
    );
  });

  it("keeps the full title in the block header even when the chip label truncates", () => {
    const title = "t".repeat(200);
    const block = buildIssueContextBlock([makeSelection({ title })]);
    expect(block).toContain(`- #123 ${title}:`);
    expect(block).not.toContain("…");
  });

  it("separates multiple issues with a blank line", () => {
    const block = buildIssueContextBlock([
      makeSelection(),
      makeSelection({ number: 124, title: "Second", body: "", comments: [] }),
    ]);
    expect(block).toContain("\n\n- #124 Second:");
  });
});

describe("appendIssueContextsToPrompt", () => {
  it("leaves the prompt untouched when there are no contexts", () => {
    expect(appendIssueContextsToPrompt("Investigate this", [])).toBe("Investigate this");
  });

  it("appends the block after the trimmed prompt", () => {
    const prompt = appendIssueContextsToPrompt("  Investigate this  ", [makeSelection()]);
    expect(prompt.startsWith("Investigate this\n\n<issue_context>")).toBe(true);
  });

  it("emits only the block when the prompt is empty", () => {
    expect(
      appendIssueContextsToPrompt("   ", [makeSelection()]).startsWith("<issue_context>"),
    ).toBe(true);
  });
});

describe("extractTrailingIssueContexts", () => {
  it("round-trips the appended block", () => {
    const prompt = appendIssueContextsToPrompt("Investigate this", [makeSelection()]);
    const extracted = extractTrailingIssueContexts(prompt);
    expect(extracted.promptText).toBe("Investigate this");
    expect(extracted.contextCount).toBe(1);
    expect(extracted.contexts[0]?.header).toBe("#123 Fix login crash");
  });

  it("preserves prompt text when no trailing block exists", () => {
    expect(extractTrailingIssueContexts("No attached issue")).toEqual({
      promptText: "No attached issue",
      contextCount: 0,
      contexts: [],
    });
  });
});

describe("deriveDisplayedUserMessageState", () => {
  it("strips the issue block from the visible transcript text", () => {
    const prompt = appendIssueContextsToPrompt("Investigate this", [makeSelection()]);
    const state = deriveDisplayedUserMessageState(prompt);
    expect(state.visibleText).toBe("Investigate this");
    expect(state.copyText).toBe(prompt);
    expect(state.issueContexts.map((entry) => entry.header)).toEqual(["#123 Fix login crash"]);
  });
});

describe("newIssueContextId", () => {
  it("mints unique prefixed ids", () => {
    const ids = new Set(Array.from({ length: 10 }, () => newIssueContextId()));
    expect(ids.size).toBe(10);
    for (const id of ids) expect(id.startsWith("issue_")).toBe(true);
  });
});
