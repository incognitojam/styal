import {
  resolveStatusPageNotice,
  type StatusPageNotice,
  withStatusPageComponents,
} from "./statusPage";

export const OPENAI_STATUS_PAGE_URL = "https://status.openai.com";
export const OPENAI_STATUS_SUMMARY_URL = `${OPENAI_STATUS_PAGE_URL}/api/v2/summary.json`;
export const OPENAI_STATUS_COMPONENTS_URL = `${OPENAI_STATUS_PAGE_URL}/api/v2/components.json`;

/**
 * Surfaces a local Codex turn never calls. Responses, Codex API, CLI, and Login stay visible, so a
 * shared outage still shows, and any new or renamed component still shows.
 */
const OPENAI_IGNORED_COMPONENTS = [
  "Ads API",
  "Ads Manager",
  "Agent",
  "Agents",
  "Audio",
  "Batch",
  "Chat Completions",
  "ChatGPT Atlas",
  "ChatGPT Space Pages",
  "ChatGPT Work",
  "Codex in ChatGPT Desktop",
  "Codex Web",
  "Compliance API",
  "Connectors/Apps",
  "Conversations",
  "Deep Research",
  "dots",
  "Embeddings",
  "FedRAMP",
  "File uploads",
  "Files",
  "Fine-tuning",
  "GPTs",
  "Image Generation",
  "Images",
  "Moderations",
  "Realtime",
  "Search",
  "Sites",
  "Sora",
  "Space",
  "Voice mode",
  "VS Code extension",
];

/**
 * Componentless incidents whose scope cannot interrupt a Codex turn. Keep
 * these anchored to the status-page title so a broader incident mentioning
 * the same product or workflow still surfaces.
 */
const OPENAI_IGNORED_INCIDENT_PATTERNS = [
  /^Degraded Performance of Dots on Enterprise\.?$/i,
  /^Delayed support responses\.?$/i,
  /^New Ad Accounts failing to provision admins\.?$/i,
  /^Delayed Costs data in the Compliance API\.?$/i,
  /^Support available via email\.?$/i,
  /^Elevated errors in ChatGPT Space Pages\.?$/i,
  /^Elevated errors in ChatGPT Work\.?$/i,
  /^Overbilling for OpenAI-hosted containers in the Agent API\.?$/i,
  /^SSO sign-in and SCIM provisioning issues\.?$/i,
];

export type OpenAIStatusNotice = StatusPageNotice;

export function resolveOpenAIStatusNotice(
  summary: unknown,
  components?: unknown,
): OpenAIStatusNotice | null {
  const completeSummary =
    components === undefined ? null : withStatusPageComponents(summary, components);
  return resolveStatusPageNotice(completeSummary ?? summary, "OpenAI", {
    ignoredComponents: OPENAI_IGNORED_COMPONENTS,
    ignoredIncidentPatterns: OPENAI_IGNORED_INCIDENT_PATTERNS,
  });
}
