import { resolveStatusPageNotice, type StatusPageNotice } from "./statusPage";

export const CLAUDE_STATUS_PAGE_URL = "https://status.claude.com";
export const CLAUDE_STATUS_SUMMARY_URL = `${CLAUDE_STATUS_PAGE_URL}/api/v2/summary.json`;

/**
 * Surfaces Claude Code never touches. It reaches Anthropic through the API
 * regardless of whether it authenticates with a key or a subscription, so a
 * disruption confined to the consumer app, the developer console, or a sibling
 * product cannot reach a turn running here. Anything not named stays visible.
 */
const CLAUDE_IGNORED_COMPONENTS = [
  "claude.ai",
  "Claude Console",
  "Claude Cowork",
  "Claude for Government",
];

export type ClaudeStatusNotice = StatusPageNotice;

export function resolveClaudeStatusNotice(input: unknown): ClaudeStatusNotice | null {
  return resolveStatusPageNotice(input, "Claude", {
    ignoredComponents: CLAUDE_IGNORED_COMPONENTS,
  });
}
