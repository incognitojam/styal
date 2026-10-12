import {
  COMPOSER_CONTEXT_ISSUE_BODY_MAX_CHARS,
  COMPOSER_CONTEXT_ISSUE_MAX_COMMENTS,
  IssueContextRecord,
  type SourceControlIssue,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { extractTrailingIssueContexts, issueContextRecord } from "./issueContext";

const isIssueContextRecord = Schema.is(IssueContextRecord);

function makeIssue(overrides?: Partial<SourceControlIssue>): SourceControlIssue {
  return {
    provider: "github",
    repository: "acme/web",
    number: 123,
    title: "Fix login crash",
    url: "https://github.com/acme/web/issues/123",
    state: "open",
    author: "octocat",
    body: "Steps to reproduce",
    comments: [{ author: "hubot", body: "Repros here" }],
    ...overrides,
  } as SourceControlIssue;
}

describe("issueContextRecord", () => {
  it("trims strings and normalizes line endings", () => {
    const record = issueContextRecord(
      makeIssue({
        title: "  Fix login crash  ",
        url: "  https://github.com/acme/web/issues/123  ",
        author: "  octocat  ",
        body: "\r\nStep one\r\nStep two\n\n",
        comments: [{ author: "  hubot  ", body: "\n Repros here \n" }],
      }),
    );
    expect(record).toMatchObject({
      kind: "issue",
      label: "#123 Fix login crash",
      title: "Fix login crash",
      url: "https://github.com/acme/web/issues/123",
      author: "octocat",
      body: "Step one\nStep two",
      comments: [{ author: "hubot", body: "Repros here" }],
    });
  });

  it("clamps an oversized issue to what the record schema accepts", () => {
    const record = issueContextRecord(
      makeIssue({
        body: "x".repeat(COMPOSER_CONTEXT_ISSUE_BODY_MAX_CHARS + 500),
        comments: Array.from({ length: COMPOSER_CONTEXT_ISSUE_MAX_COMMENTS + 5 }, () => ({
          author: null,
          body: "comment",
        })),
      }),
    );
    expect(record?.body.length).toBe(COMPOSER_CONTEXT_ISSUE_BODY_MAX_CHARS);
    expect(record?.comments).toHaveLength(COMPOSER_CONTEXT_ISSUE_MAX_COMMENTS);
    expect(isIssueContextRecord(record)).toBe(true);
  });

  it("truncates a long title in the label but keeps it whole in the payload", () => {
    const title = "A".repeat(80);
    const record = issueContextRecord(makeIssue({ title }));
    expect(record?.title).toBe(title);
    expect(record?.label.length).toBeLessThan(title.length);
    expect(record?.label.endsWith("…")).toBe(true);
  });

  it("gives the same issue the same context id and different issues different ids", () => {
    const first = issueContextRecord(makeIssue());
    const again = issueContextRecord(makeIssue({ title: "Renamed", body: "Edited" }));
    const otherRepo = issueContextRecord(makeIssue({ repository: "acme/api" }));
    const otherNumber = issueContextRecord(makeIssue({ number: 124 }));
    expect(again?.contextId).toBe(first?.contextId);
    expect(otherRepo?.contextId).not.toBe(first?.contextId);
    expect(otherNumber?.contextId).not.toBe(first?.contextId);
  });

  it("rejects an issue without a usable number or title", () => {
    expect(issueContextRecord(makeIssue({ number: 0 }))).toBeNull();
    expect(issueContextRecord(makeIssue({ title: "   " }))).toBeNull();
  });
});

const LEGACY_ISSUE_BLOCK = [
  "<issue_context>",
  "- #123 Fix login crash:",
  "  repository: acme/web",
  "  state: open",
  "  body:",
  "    Steps to reproduce",
  "</issue_context>",
].join("\n");

describe("extractTrailingIssueContexts", () => {
  it("splits the block off a message sent before issues became context records", () => {
    const extracted = extractTrailingIssueContexts(`Investigate this\n\n${LEGACY_ISSUE_BLOCK}`);
    expect(extracted.promptText).toBe("Investigate this");
    expect(extracted.contexts.map((entry) => entry.header)).toEqual(["#123 Fix login crash"]);
    expect(extracted.contexts[0]?.body).toContain("state: open");
  });

  it("preserves prompt text when no trailing block exists", () => {
    expect(extractTrailingIssueContexts("No attached issue")).toEqual({
      promptText: "No attached issue",
      contextCount: 0,
      contexts: [],
    });
  });

  it("strips an issue block followed by blocks from before inline context references", () => {
    const terminalBlock =
      "<terminal_context>\n- Terminal 1 line 3:\n  3 | failed\n</terminal_context>";
    const prompt = `Investigate this\n\n${LEGACY_ISSUE_BLOCK}\n\n${terminalBlock}`;
    const extracted = extractTrailingIssueContexts(prompt);
    expect(extracted.promptText).toBe(`Investigate this\n\n${terminalBlock}`);
    expect(extracted.contexts.map((entry) => entry.header)).toEqual(["#123 Fix login crash"]);
  });

  it("leaves an issue block alone when prose follows it", () => {
    const prompt = `Investigate this\n\n${LEGACY_ISSUE_BLOCK}\n\nMore text`;
    expect(extractTrailingIssueContexts(prompt)).toEqual({
      promptText: prompt,
      contextCount: 0,
      contexts: [],
    });
  });
});
