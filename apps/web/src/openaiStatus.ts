import {
  resolveStatusPageNotice,
  type StatusPageNotice,
  withStatusPageComponents,
} from "./statusPage";

export const OPENAI_STATUS_PAGE_URL = "https://status.openai.com";
export const OPENAI_STATUS_SUMMARY_URL = `${OPENAI_STATUS_PAGE_URL}/api/v2/summary.json`;
export const OPENAI_STATUS_COMPONENTS_URL = `${OPENAI_STATUS_PAGE_URL}/api/v2/components.json`;

/**
 * Consumer and enterprise surfaces a Codex turn never calls. The list stops
 * short of the shared API services and the Codex clients, which the alert is
 * meant to cover even when the disruption is not ours; anything unnamed, new
 * or renamed, still shows.
 */
const OPENAI_IGNORED_COMPONENTS = [
  "Ads API",
  "Ads Manager",
  "Agent",
  "Audio",
  "ChatGPT Atlas",
  "ChatGPT Work",
  "Compliance API",
  "Deep Research",
  "FedRAMP",
  "Fine-tuning",
  "GPTs",
  "Sites",
  "Sora",
  "Voice mode",
];

/**
 * Componentless incidents whose scope cannot interrupt a Codex turn. Keep
 * these anchored to the status-page title so a broader incident mentioning
 * the same product or workflow still surfaces.
 */
const OPENAI_IGNORED_INCIDENT_PATTERNS = [
  /^Delayed support responses\.?$/i,
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
