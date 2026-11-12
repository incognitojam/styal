import { resolveStatusPageNotice, type StatusPageNotice } from "./statusPage";

export const CLAUDE_STATUS_PAGE_URL = "https://status.claude.com";
export const CLAUDE_STATUS_SUMMARY_URL = `${CLAUDE_STATUS_PAGE_URL}/api/v2/summary.json`;

/**
 * Surfaces a Claude Code turn can depend on. It reaches Anthropic through the API whether it
 * authenticates with a key or a subscription, or through a cloud platform when configured for
 * one. The consumer app, the developer console, and sibling products cannot reach a turn here.
 */
export const CLAUDE_RELEVANT_COMPONENTS = [
  "Claude API",
  "Claude Code",
  "Claude Platform on AWS",
  "Claude in Microsoft Foundry",
  "Claude Models on Google Cloud",
];

const CLAUDE_IGNORED_INCIDENT_PATTERNS = [
  /\bgoogle play\b.*\bsubscriptions?\b|\bsubscriptions?\b.*\bgoogle play\b/i,
];

export type ClaudeStatusNotice = StatusPageNotice;

export function resolveClaudeStatusNotice(input: unknown): ClaudeStatusNotice | null {
  return resolveStatusPageNotice(input, "Claude", {
    relevantComponents: CLAUDE_RELEVANT_COMPONENTS,
    ignoredIncidentPatterns: CLAUDE_IGNORED_INCIDENT_PATTERNS,
  });
}
