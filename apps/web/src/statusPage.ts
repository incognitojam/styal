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
export function withStatusPageComponents(summaryInput: unknown, componentsInput: unknown): unknown {
  const summary = decodeStatusPageSummary(summaryInput);
  const components = decodeStatusPageComponents(componentsInput);
  if (summary._tag === "None" || components._tag === "None") return null;

  return { ...summary.value, components: components.value.components };
}

function componentStatusLabel(status: string): string {
  switch (status) {
    case "degraded_performance":
      return "Degraded performance";
    case "partial_outage":
      return "Partial outage";
    case "major_outage":
      return "Major outage";
    case "under_maintenance":
      return "Under maintenance";
    default:
      return status.replaceAll("_", " ");
  }
}

function isErrorStatus(status: string): boolean {
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
 * Words that read as plain infrastructure once the vendor is known from the
 * icon, so "Claude API" can shorten to "API". Everything else keeps its vendor
 * word, because in "Claude Code" and "Claude Cowork" it names the product
 * rather than namespacing it. Unlisted means untouched, so a new component can
 * only ever be too long, never renamed into something that does not exist.
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
  if (names.length === 0) return "service disruption";
  if (names.length <= 2)
    return names.map((name) => shortComponentName(name, serviceName)).join(", ");
  return `${names.length} services`;
}

function activeIncidentsDescription(incidents: ReadonlyArray<StatusPageIncidentIssue>): string {
  return incidents.length === 1 ? "1 active incident" : `${incidents.length} active incidents`;
}

/**
 * Narrows a status page to the parts T3 Code actually depends on. Vendors run
 * far more surfaces than we drive, and an incident confined to one of them is
 * noise the sidebar should not spend a row on. Ignoring is opt-in per name, so
 * a surface the vendor adds or renames still shows up: the failure mode is a
 * notice that did not matter, never a silent one that did.
 */
export interface StatusPageRelevance {
  /** Component names, hostname suffix optional, whose disruption cannot reach T3 Code. */
  readonly ignoredComponents: ReadonlyArray<string>;
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
    affectedComponents.some((component) => isErrorStatus(component.status)) ||
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
          label: `Outage: ${affectedServicesLabel(
            affectedComponents.map((component) => component.name),
            serviceName,
          )}`,
          separator: " ",
        }
      : incidentScope.length > 0
        ? {
            label: `Incident: ${affectedServicesLabel(incidentScope, serviceName)}`,
            separator: " ",
          }
        : activeIncidents.length > 0
          ? { label: activeIncidentsDescription(activeIncidents), separator: ": " }
          : { label: "Outage: service disruption", separator: " " };

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
