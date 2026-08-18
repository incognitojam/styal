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

function affectedServicesLabel(components: ReadonlyArray<StatusPageComponentIssue>): string {
  if (components.length === 0) return "service disruption";
  if (components.length <= 2) return components.map((component) => component.name).join(", ");
  return `${components.length} services affected`;
}

function activeIncidentsDescription(incidents: ReadonlyArray<StatusPageIncidentIssue>): string {
  return incidents.length === 1 ? "1 active incident" : `${incidents.length} active incidents`;
}

export function resolveStatusPageNotice(
  input: unknown,
  serviceName: string,
): StatusPageNotice | null {
  const decoded = decodeStatusPageSummary(input);
  if (decoded._tag === "None") return null;

  const summary = decoded.value;
  const activeIncidents = (summary.incidents ?? [])
    .filter((incident) => isActiveIncidentStatus(incident.status))
    .map(
      (incident): StatusPageIncidentIssue => ({
        affectedComponents: deduplicateNames(
          (incident.components ?? [])
            .filter((component) => component.showcase !== false)
            .map((component) => component.name),
        ),
        impact: incident.impact,
        name: incident.name,
        status: incident.status,
        statusLabel: incidentStatusLabel(incident.status),
      }),
    );
  const affectedComponentsByName = new Map<string, StatusPageComponentIssue>();
  for (const component of summary.components) {
    if (component.showcase === false || component.status === "operational") continue;
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

  if (
    summary.status.indicator === "none" &&
    affectedComponents.length === 0 &&
    activeIncidents.length === 0
  ) {
    return null;
  }

  const tone =
    summary.status.indicator === "major" ||
    summary.status.indicator === "critical" ||
    affectedComponents.some((component) => isErrorStatus(component.status)) ||
    activeIncidents.some((incident) => isErrorImpact(incident.impact))
      ? "error"
      : "warning";

  const label =
    affectedComponents.length > 0
      ? `${serviceName} Outage: ${affectedServicesLabel(affectedComponents)}`
      : activeIncidents.length === 1
        ? `${serviceName} Incident: ${activeIncidents[0]?.name}`
        : activeIncidents.length > 1
          ? `${serviceName}: ${activeIncidents.length} active incidents`
          : `${serviceName} Outage: service disruption`;

  return {
    activeIncidents,
    affectedComponents,
    description:
      summary.status.indicator === "none" && affectedComponents.length === 0
        ? activeIncidentsDescription(activeIncidents)
        : summary.status.description,
    label,
    tone,
  };
}
