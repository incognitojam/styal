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

/** Codex Cloud and the Agents API are separate products a local Codex turn never calls. */
const OPENAI_RELEVANT_UNTAGGED_INCIDENT_TITLE =
  /\bcodex\b(?! cloud)|(?<!agents? )\bapi\b|\bgpt-\d|\busage limits?\b/i;

/**
 * OpenAI's status API omits incident components, so every incident arrives componentless. Its
 * impact is derived from them: "none" means no component was tagged, where only the title can show
 * relevance. Any other impact means a component was tagged, and that component's status says which.
 */
function keepOpenAIIncident(
  incident: { readonly impact: string; readonly name: string },
  relevantComponentDisrupted: boolean,
): boolean {
  return incident.impact === "none"
    ? OPENAI_RELEVANT_UNTAGGED_INCIDENT_TITLE.test(incident.name)
    : relevantComponentDisrupted;
}

export type OpenAIStatusNotice = StatusPageNotice;

export function resolveOpenAIStatusNotice(
  summary: unknown,
  components?: unknown,
): OpenAIStatusNotice | null {
  const completeSummary =
    components === undefined ? null : withStatusPageComponents(summary, components);
  return resolveStatusPageNotice(completeSummary ?? summary, "OpenAI", {
    ignoredComponents: OPENAI_IGNORED_COMPONENTS,
    keepComponentlessIncident: keepOpenAIIncident,
  });
}
