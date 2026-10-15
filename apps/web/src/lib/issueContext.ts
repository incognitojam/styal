import {
  COMPOSER_CONTEXT_ISSUE_BODY_MAX_CHARS,
  COMPOSER_CONTEXT_ISSUE_COMMENT_MAX_CHARS,
  COMPOSER_CONTEXT_ISSUE_MAX_COMMENTS,
  type IssueContextRecord,
  type SourceControlIssue,
} from "@t3tools/contracts";
import {
  sanitizeComposerContextLabel,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";

import type { ComposerContextReference } from "./composerContextReferences";

const ISSUE_CONTEXT_TITLE_LABEL_MAX = 60;
const ISSUE_CONTEXT_SHORT_FIELD_MAX = 2_048;

// Messages sent before inline context references appended terminal, element and preview blocks
// after the issue block; those stay in place for the legacy context upgrade to peel.
const TRAILING_ISSUE_CONTEXT_BLOCK_PATTERN =
  /\n*<issue_context>\n([\s\S]*?)\n<\/issue_context>(?=((?:\s*<(terminal_context|element_context|preview_annotation)>\n[\s\S]*?\n<\/\3>)*)\s*$)/;

export interface ParsedIssueContextEntry {
  header: string;
  body: string;
}

export interface ExtractedIssueContexts {
  promptText: string;
  contextCount: number;
  contexts: ParsedIssueContextEntry[];
}

function truncateString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function shortField(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? truncateString(trimmed, ISSUE_CONTEXT_SHORT_FIELD_MAX) : null;
}

/**
 * Snapshot a fetched issue as a context record, clamped to what the record schema accepts.
 * The same issue always gets the same context id, so attaching it twice reuses the chip.
 * Returns `null` for an issue without a usable number or title.
 */
export function issueContextRecord(raw: SourceControlIssue): IssueContextRecord | null {
  const title = shortField(raw.title);
  if (!Number.isSafeInteger(raw.number) || raw.number <= 0 || title === null) return null;
  const repository = shortField(raw.repository);
  const identity = [raw.provider, repository ?? "", String(raw.number)].join("|").toLowerCase();
  return {
    version: 1,
    kind: "issue",
    contextId: toKindScopedComposerContextId("issue", identity),
    label: sanitizeComposerContextLabel(
      `#${raw.number} ${truncateString(title, ISSUE_CONTEXT_TITLE_LABEL_MAX)}`,
      "issue",
    ),
    provider: raw.provider,
    repository,
    number: raw.number,
    title,
    url: shortField(raw.url) ?? "",
    state: raw.state,
    author: shortField(raw.author),
    body: truncateString(normalizeText(raw.body), COMPOSER_CONTEXT_ISSUE_BODY_MAX_CHARS),
    comments: raw.comments.slice(0, COMPOSER_CONTEXT_ISSUE_MAX_COMMENTS).map((comment) => ({
      author: shortField(comment.author),
      body: truncateString(normalizeText(comment.body), COMPOSER_CONTEXT_ISSUE_COMMENT_MAX_CHARS),
    })),
  };
}

export function issueContextReference(record: IssueContextRecord): ComposerContextReference {
  return { kind: "issue", contextId: record.contextId, label: record.label };
}

/**
 * Splits the `<issue_context>` block off a message sent before issues became context
 * records, for display. Legacy context blocks that followed it remain in `promptText`.
 */
export function extractTrailingIssueContexts(prompt: string): ExtractedIssueContexts {
  const match = TRAILING_ISSUE_CONTEXT_BLOCK_PATTERN.exec(prompt);
  if (!match) {
    return { promptText: prompt, contextCount: 0, contexts: [] };
  }
  const promptText = `${prompt.slice(0, match.index).replace(/\n+$/, "")}${match[2] ?? ""}`;
  const contexts = parseIssueContextEntries(match[1] ?? "");
  return { promptText, contextCount: contexts.length, contexts };
}

function parseIssueContextEntries(block: string): ParsedIssueContextEntry[] {
  const entries: ParsedIssueContextEntry[] = [];
  let current: { header: string; bodyLines: string[] } | null = null;
  const commit = () => {
    if (!current) return;
    entries.push({ header: current.header, body: current.bodyLines.join("\n").trimEnd() });
    current = null;
  };
  for (const line of block.split("\n")) {
    const headerMatch = /^- (.+):$/.exec(line);
    if (headerMatch) {
      commit();
      current = { header: headerMatch[1]!, bodyLines: [] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("  ")) current.bodyLines.push(line.slice(2));
    else if (line.length === 0) current.bodyLines.push("");
  }
  commit();
  return entries;
}
