import { type ThreadId } from "@t3tools/contracts";
import type { SourceControlIssue, SourceControlProviderKind } from "@t3tools/contracts";

/**
 * Issue bodies and comment threads can be enormous. We prefer including
 * everything, so these caps sit well above a realistic issue and only exist so
 * one pathological thread can't blow up the draft store or the prompt.
 */
const ISSUE_CONTEXT_BODY_LIMIT = 24_000;
const ISSUE_CONTEXT_COMMENT_LIMIT = 8_000;
const ISSUE_CONTEXT_MAX_COMMENTS = 50;
const ISSUE_CONTEXT_TITLE_LABEL_MAX = 60;

const TRAILING_ISSUE_CONTEXT_BLOCK_PATTERN =
  /\n*<issue_context>\n([\s\S]*?)\n<\/issue_context>\s*$/;

export interface IssueContextComment {
  author: string | null;
  body: string;
}

/**
 * A source-control issue attached to a composer draft. The full payload is
 * persisted inline — there is no live session to re-fetch it from when a draft
 * is restored, and re-hitting `gh` on hydration would be both slow and racy.
 */
export interface IssueContextSelection {
  provider: SourceControlProviderKind;
  /** `owner/repo`, or null when the provider didn't report one. */
  repository: string | null;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  author: string | null;
  body: string;
  comments: IssueContextComment[];
}

export interface IssueContextDraft extends IssueContextSelection {
  /** Stable composer-side id used for keyed rendering + dedupe. */
  id: string;
  threadId: ThreadId;
  /** ISO-8601 wall clock attach time. */
  attachedAt: string;
}

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

/**
 * Clamp a freshly fetched issue before it lands in a persisted draft. Returns
 * `null` for issues we can't render a useful chip for.
 */
export function normalizeIssueContextSelection(
  raw: SourceControlIssue,
): IssueContextSelection | null {
  const title = raw.title.trim();
  if (!Number.isSafeInteger(raw.number) || raw.number <= 0 || title.length === 0) {
    return null;
  }
  return {
    provider: raw.provider,
    repository: raw.repository?.trim() || null,
    number: raw.number,
    title,
    url: raw.url.trim(),
    state: raw.state,
    author: raw.author?.trim() || null,
    body: truncateString(normalizeText(raw.body), ISSUE_CONTEXT_BODY_LIMIT),
    comments: raw.comments.slice(0, ISSUE_CONTEXT_MAX_COMMENTS).map((comment) => ({
      author: comment.author?.trim() || null,
      body: truncateString(normalizeText(comment.body), ISSUE_CONTEXT_COMMENT_LIMIT),
    })),
  };
}

/**
 * Two attaches of the same issue produce the same key, so re-running the
 * command for an already-attached issue is a no-op instead of a duplicate chip.
 */
export function issueContextDedupKey(context: IssueContextSelection): string {
  return [context.provider, context.repository ?? "", String(context.number)]
    .join("|")
    .toLowerCase();
}

/** Compact chip label — `#123 Fix login crash`. */
export function formatIssueContextLabel(context: IssueContextSelection): string {
  return `#${context.number} ${truncateString(context.title, ISSUE_CONTEXT_TITLE_LABEL_MAX)}`;
}

function indentLines(value: string): string[] {
  return value.split("\n").map((line) => `  ${line}`);
}

function buildSingleContextLines(context: IssueContextSelection): string[] {
  const lines: string[] = [];
  lines.push(`- #${context.number} ${context.title}:`);
  if (context.repository) {
    lines.push(`  repository: ${context.repository}`);
  }
  lines.push(`  state: ${context.state}`);
  if (context.author) {
    lines.push(`  author: ${context.author}`);
  }
  if (context.url.length > 0) {
    lines.push(`  url: ${context.url}`);
  }
  const body = context.body.trim();
  if (body.length > 0) {
    lines.push("  body:");
    lines.push(...indentLines(body));
  }
  for (const comment of context.comments) {
    const commentBody = comment.body.trim();
    if (commentBody.length === 0) continue;
    lines.push(`  comment by ${comment.author ?? "unknown"}:`);
    lines.push(...indentLines(commentBody));
  }
  return lines;
}

/**
 * Serialize issue-context drafts into the `<issue_context>` block we append to
 * the user's outgoing message text. Mirrors the `<terminal_context>` and
 * `<element_context>` block formats so all three compose cleanly.
 */
export function buildIssueContextBlock(contexts: ReadonlyArray<IssueContextSelection>): string {
  if (contexts.length === 0) return "";
  const lines: string[] = [];
  for (let index = 0; index < contexts.length; index += 1) {
    const context = contexts[index]!;
    lines.push(...buildSingleContextLines(context));
    if (index < contexts.length - 1) lines.push("");
  }
  return ["<issue_context>", ...lines, "</issue_context>"].join("\n");
}

export function appendIssueContextsToPrompt(
  prompt: string,
  contexts: ReadonlyArray<IssueContextSelection>,
): string {
  const block = buildIssueContextBlock(contexts);
  if (block.length === 0) return prompt;
  const trimmed = prompt.trim();
  return trimmed.length > 0 ? `${trimmed}\n\n${block}` : block;
}

const ISSUE_CONTEXT_ID_PREFIX = "issue_";
let nextIssueContextSequence = 0;

export function newIssueContextId(): string {
  nextIssueContextSequence += 1;
  return `${ISSUE_CONTEXT_ID_PREFIX}${nextIssueContextSequence.toString(36)}`;
}

/**
 * Mirror image of `appendIssueContextsToPrompt` for transcript display. The
 * issue block is appended before the terminal/element blocks, so callers must
 * strip those two first for this trailing-anchored match to land.
 */
export function extractTrailingIssueContexts(prompt: string): ExtractedIssueContexts {
  const match = TRAILING_ISSUE_CONTEXT_BLOCK_PATTERN.exec(prompt);
  if (!match) {
    return { promptText: prompt, contextCount: 0, contexts: [] };
  }
  const promptText = prompt.slice(0, match.index).replace(/\n+$/, "");
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
