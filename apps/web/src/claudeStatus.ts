import { resolveStatusPageNotice, type StatusPageNotice } from "./statusPage";

export const CLAUDE_STATUS_PAGE_URL = "https://status.claude.com";
export const CLAUDE_STATUS_SUMMARY_URL = `${CLAUDE_STATUS_PAGE_URL}/api/v2/summary.json`;

export type ClaudeStatusNotice = StatusPageNotice;

export function resolveClaudeStatusNotice(input: unknown): ClaudeStatusNotice | null {
  return resolveStatusPageNotice(input, "Claude");
}
