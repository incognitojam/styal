import { msg } from "gt-react";
import { m } from "./i18n/messages";
import * as Schema from "effect/Schema";

const StatusPageComponentSchema = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  showcase: Schema.optional(Schema.Boolean),
});

const StatusPageSummarySchema = Schema.Struct({
  status: Schema.Struct({
    description: Schema.String,
    indicator: Schema.String,
  }),
  components: Schema.Array(StatusPageComponentSchema),
  incidents: Schema.optional(
    Schema.Array(
      Schema.Struct({
        components: Schema.optional(
          Schema.Array(
            Schema.Struct({
              name: Schema.String,
              showcase: Schema.optional(Schema.Boolean),
            }),
          ),
        ),
        impact: Schema.String,
        name: Schema.String,
        status: Schema.String,
      }),
    ),
  ),
});

const decodeStatusPageSummary = Schema.decodeUnknownOption(StatusPageSummarySchema);
const decodeStatusPageComponents = Schema.decodeUnknownOption(
  Schema.Struct({ components: Schema.Array(StatusPageComponentSchema) }),
);

export function isStatusPageSummary(input: unknown): boolean {
  return decodeStatusPageSummary(input)._tag === "Some";
}

export type StatusPageNoticeTone = "warning" | "error";

export interface StatusPageComponentIssue {
  readonly name: string;
  readonly status: string;
  readonly statusLabel: string;
}

export interface StatusPageIncidentIssue {
  readonly affectedComponents: ReadonlyArray<string>;
  readonly impact: string;
  readonly name: string;
  readonly status: string;
  readonly statusLabel: string;
}

export interface StatusPageNotice {
  /** Spoken form of `label`, which names the service the icon stands in for. */
  readonly accessibleLabel: string;
  readonly activeIncidents: ReadonlyArray<StatusPageIncidentIssue>;
  readonly affectedComponents: ReadonlyArray<StatusPageComponentIssue>;
  readonly description: string;
  readonly label: string;
  readonly tone: StatusPageNoticeTone;
}

/**
 * Applies a complete component listing to a status summary. Some status pages
 * omit recently added components from `summary.json` while exposing them from
 * `components.json`.
 */
function withStatusPageComponents(summaryInput: unknown, componentsInput: unknown): unknown {
  const summary = decodeStatusPageSummary(summaryInput);
  const components = decodeStatusPageComponents(componentsInput);
  if (summary._tag === "None" || components._tag === "None") return null;

  return { ...summary.value, components: components.value.components };
}

function componentStatusLabel(status: string): string {
  switch (status) {
    case "degraded_performance":
      return m(msg("Degraded performance"));
    case "partial_outage":
      return m(msg("Partial outage"));
    case "major_outage":
      return m(msg("Major outage"));
    case "under_maintenance":
      return m(msg("Under maintenance"));
    default:
      return status.replaceAll("_", " ");
  }
}

/** Whether a component status counts as an outage rather than a degradation. */
export function isOutageComponentStatus(status: string): boolean {
  return status === "partial_outage" || status === "major_outage";
}

function componentStatusSeverity(status: string): number {
  switch (status) {
    case "major_outage":
      return 4;
    case "partial_outage":
      return 3;
    case "degraded_performance":
      return 2;
    case "under_maintenance":
      return 1;
    default:
      return 0;
  }
}

/**
 * Names the worst component disruption, so degraded performance or maintenance
 * is not announced as an outage.
 */
function componentDisruptionPrefix(components: ReadonlyArray<StatusPageComponentIssue>): string {
  if (components.some((component) => isOutageComponentStatus(component.status)))
    return m(msg("Outage"));
  if (components.some((component) => component.status === "degraded_performance")) {
    return m(msg("Degraded"));
  }
  if (components.every((component) => component.status === "under_maintenance")) {
    return m(msg("Maintenance"));
  }
  return m(msg("Outage"));
}

function componentNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Drops the hostname a status page appends for disambiguation. */
function withoutComponentHost(name: string): string {
  const stripped = name.replace(/\s*\([^()]*\)$/, "").trim();
  return stripped.length > 0 ? stripped : name;
}

/**
 * Matches an ignore-list entry against a component name, ignoring the appended
 * hostname so "Claude Console" keeps matching if the host it names ever moves.
 */
function componentIgnoreKey(name: string): string {
  return componentNameKey(withoutComponentHost(name));
}

function deduplicateNames(names: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Map(names.map((name) => [componentNameKey(name), name])).values()];
}

function incidentStatusLabel(status: string): string {
  return `${status.charAt(0).toUpperCase()}${status.slice(1).replaceAll("_", " ")}`;
}

function isActiveIncidentStatus(status: string): boolean {
  return status !== "resolved" && status !== "postmortem";
}

function isErrorImpact(impact: string): boolean {
  return impact === "major" || impact === "critical";
}

/**
 * Words that read as plain infrastructure once the icon shows the vendor, so "Claude API" can
 * shorten to "API". Other names keep the vendor word, as in "Claude Code", so a new component can
 * only be too long, never renamed into something that does not exist.
 */
const GENERIC_COMPONENT_NAMES = new Set(["api", "console", "dashboard", "platform"]);

/**
 * Shortens a component name for the pill: the hostname a status page appends
 * for disambiguation always goes, the vendor word only when what follows is
 * generic. The tooltip shows the name exactly as the status page wrote it.
 */
function shortComponentName(name: string, serviceName: string): string {
  const base = withoutComponentHost(name);
  const prefix = `${serviceName} `;
  if (!base.toLowerCase().startsWith(prefix.toLowerCase())) return base;
  const remainder = base.slice(prefix.length);
  return GENERIC_COMPONENT_NAMES.has(remainder.toLowerCase()) ? remainder : base;
}

/**
 * Names the disrupted services for the sidebar pill, which fits about thirty
 * characters. Two names generally fit now that the pill no longer repeats the
 * vendor; past two only the count does.
 */
function affectedServicesLabel(names: ReadonlyArray<string>, serviceName: string): string {
  if (names.length === 0) return m(msg("service disruption"));
  if (names.length <= 2)
    return names.map((name) => shortComponentName(name, serviceName)).join(", ");
  return m(msg("{count} services"), { count: names.length });
}

function activeIncidentsDescription(incidents: ReadonlyArray<StatusPageIncidentIssue>): string {
  return m(msg("{count, plural, one {{count} active incident} other {{count} active incidents}}"), {
    count: incidents.length,
  });
}

/**
 * Ignoring is opt-in per name, so a surface the vendor adds or renames still shows up: the
 * failure mode is a notice that did not matter, never a missed one that did.
 */
export interface StatusPageRelevance {
  /** Component names, hostname suffix optional, whose disruption cannot reach styal. */
  readonly ignoredComponents: ReadonlyArray<string>;
  /** Incident-name patterns for unrelated disruptions with no assigned component. */
  readonly ignoredIncidentPatterns?: ReadonlyArray<RegExp>;
  /**
   * Decides componentless incidents for a page whose API omits incident components. This inverts
   * the default above: an incident it rejects can be a real one, so use it only with evidence.
   */
  readonly keepComponentlessIncident?: (
    incident: { readonly impact: string; readonly name: string },
    relevantComponentDisrupted: boolean,
  ) => boolean;
}

export function resolveStatusPageNotice(
  input: unknown,
  serviceName: string,
  relevance?: StatusPageRelevance,
): StatusPageNotice | null {
  const decoded = decodeStatusPageSummary(input);
  if (decoded._tag === "None") return null;

  const ignoredComponents = new Set(
    (relevance?.ignoredComponents ?? []).map((name) => componentIgnoreKey(name)),
  );
  const isIgnoredComponent = (name: string) => ignoredComponents.has(componentIgnoreKey(name));
  // Set when the page reported a disruption we deliberately dropped, which is
  // what separates "nothing relevant is wrong" from "we could not attribute
  // this" further down.
  let ignoredAnyDisruption = false;

  const summary = decoded.value;
  const relevantComponentDisrupted = summary.components.some(
    (component) =>
      component.showcase !== false &&
      component.status !== "operational" &&
      !isIgnoredComponent(component.name),
  );
  const activeIncidents = (summary.incidents ?? [])
    .filter((incident) => isActiveIncidentStatus(incident.status))
    .flatMap((incident): ReadonlyArray<StatusPageIncidentIssue> => {
      const scope = deduplicateNames(
        (incident.components ?? [])
          .filter((component) => component.showcase !== false)
          .map((component) => component.name),
      );
      // An incident spanning both kinds of surface is still ours, so it keeps
      // only the components we care about rather than diluting the scope. One
      // naming no component at all is unattributable, not irrelevant.
      const relevant = scope.filter((name) => !isIgnoredComponent(name));
      if (
        scope.length === 0 &&
        (relevance?.ignoredIncidentPatterns?.some((pattern) => pattern.test(incident.name)) ||
          relevance?.keepComponentlessIncident?.(incident, relevantComponentDisrupted) === false)
      ) {
        ignoredAnyDisruption = true;
        return [];
      }
      if (scope.length > 0 && relevant.length === 0) {
        ignoredAnyDisruption = true;
        return [];
      }
      return [
        {
          affectedComponents: relevant,
          impact: incident.impact,
          name: incident.name,
          status: incident.status,
          statusLabel: incidentStatusLabel(incident.status),
        },
      ];
    });
  const affectedComponentsByName = new Map<string, StatusPageComponentIssue>();
  for (const component of summary.components) {
    if (component.showcase === false || component.status === "operational") continue;
    if (isIgnoredComponent(component.name)) {
      ignoredAnyDisruption = true;
      continue;
    }
    const issue: StatusPageComponentIssue = {
      name: component.name,
      status: component.status,
      statusLabel: componentStatusLabel(component.status),
    };
    const key = componentNameKey(component.name);
    const existing = affectedComponentsByName.get(key);
    if (
      !existing ||
      componentStatusSeverity(issue.status) > componentStatusSeverity(existing.status)
    ) {
      affectedComponentsByName.set(key, issue);
    }
  }
  const affectedComponents = [...affectedComponentsByName.values()];

  // The aggregate indicator covers every surface the vendor runs, so on its own
  // it cannot justify a notice once the only disruptions behind it were ignored.
  if (
    affectedComponents.length === 0 &&
    activeIncidents.length === 0 &&
    (summary.status.indicator === "none" || ignoredAnyDisruption)
  ) {
    return null;
  }

  // Once something was ignored, the aggregate indicator describes surfaces we
  // are no longer reporting on, so severity comes from what survived instead.
  const tone =
    (!ignoredAnyDisruption &&
      (summary.status.indicator === "major" || summary.status.indicator === "critical")) ||
    affectedComponents.some((component) => isOutageComponentStatus(component.status)) ||
    activeIncidents.some((incident) => isErrorImpact(incident.impact))
      ? "error"
      : "warning";

  // A lone incident still names its scope, which says far more than a bare count
  // about whether the disruption touches your work. Past one incident the titles
  // and scopes overlap, so the count is the honest summary.
  const incidentScope =
    activeIncidents.length === 1 ? (activeIncidents[0]?.affectedComponents ?? []) : [];

  // The pill drops the service name because its icon already carries it; that
  // buys back roughly a third of the row. `separator` rejoins the two for the
  // accessible name, where there is no icon to lean on.
  const rendered =
    affectedComponents.length > 0
      ? {
          label: `${componentDisruptionPrefix(affectedComponents)}: ${affectedServicesLabel(
            affectedComponents.map((component) => component.name),
            serviceName,
          )}`,
          separator: " ",
        }
      : incidentScope.length > 0
        ? {
            label: m(msg("Incident: {services}"), {
              services: affectedServicesLabel(incidentScope, serviceName),
            }),
            separator: " ",
          }
        : activeIncidents.length > 0
          ? { label: activeIncidentsDescription(activeIncidents), separator: ": " }
          : { label: m(msg("Outage: service disruption")), separator: " " };

  return {
    accessibleLabel: `${serviceName}${rendered.separator}${rendered.label}`,
    activeIncidents,
    affectedComponents,
    description:
      affectedComponents.length === 0 &&
      (summary.status.indicator === "none" || ignoredAnyDisruption)
        ? activeIncidentsDescription(activeIncidents)
        : summary.status.description,
    label: rendered.label,
    tone,
  };
}

export const GITHUB_STATUS_PAGE_URL = "https://www.githubstatus.com";
export const GITHUB_STATUS_SUMMARY_URL = `${GITHUB_STATUS_PAGE_URL}/api/v2/summary.json`;

export type GitHubStatusNotice = StatusPageNotice;

export function hasGitHubProject(
  projects: ReadonlyArray<{
    readonly repositoryIdentity?: { readonly provider?: string | undefined } | null | undefined;
  }>,
): boolean {
  return projects.some((project) => project.repositoryIdentity?.provider === "github");
}

/**
 * Surfaces no source-control work depends on. Git operations, pull requests,
 * Actions, and deploys all stay visible; Copilot is a separate product whose
 * disruption says nothing about pushing or reviewing code from here.
 */
const GITHUB_IGNORED_COMPONENTS = ["Copilot", "Copilot AI Model Providers"];

export function resolveGitHubStatusNotice(input: unknown): GitHubStatusNotice | null {
  return resolveStatusPageNotice(input, "GitHub", {
    ignoredComponents: GITHUB_IGNORED_COMPONENTS,
  });
}

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

const CLAUDE_IGNORED_INCIDENT_PATTERNS = [
  /\bgoogle play\b.*\bsubscriptions?\b|\bsubscriptions?\b.*\bgoogle play\b/i,
];

export type ClaudeStatusNotice = StatusPageNotice;

export function resolveClaudeStatusNotice(input: unknown): ClaudeStatusNotice | null {
  return resolveStatusPageNotice(input, "Claude", {
    ignoredComponents: CLAUDE_IGNORED_COMPONENTS,
    ignoredIncidentPatterns: CLAUDE_IGNORED_INCIDENT_PATTERNS,
  });
}

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
