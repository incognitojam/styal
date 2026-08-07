import * as Schema from "effect/Schema";

export const GITHUB_STATUS_PAGE_URL = "https://www.githubstatus.com";
export const GITHUB_STATUS_SUMMARY_URL = `${GITHUB_STATUS_PAGE_URL}/api/v2/summary.json`;
export const GITHUB_STATUS_PREVIEW_PARAM = "github-status";

const GitHubStatusSummarySchema = Schema.Struct({
  status: Schema.Struct({
    description: Schema.String,
    indicator: Schema.String,
  }),
  components: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      showcase: Schema.optional(Schema.Boolean),
    }),
  ),
});

const decodeGitHubStatusSummary = Schema.decodeUnknownOption(GitHubStatusSummarySchema);

export type GitHubStatusNoticeTone = "warning" | "error";

export interface GitHubStatusComponentIssue {
  readonly name: string;
  readonly status: string;
  readonly statusLabel: string;
}

export interface GitHubStatusNotice {
  readonly affectedComponents: ReadonlyArray<GitHubStatusComponentIssue>;
  readonly description: string;
  readonly label: string;
  readonly tone: GitHubStatusNoticeTone;
}

const GITHUB_STATUS_PREVIEWS = {
  partial: {
    affectedComponents: [
      { name: "Actions", status: "major_outage", statusLabel: "Major outage" },
      { name: "Pages", status: "major_outage", statusLabel: "Major outage" },
    ],
    description: "Partial System Outage",
    label: "GitHub Outage: Actions, Pages",
    tone: "error",
  },
  major: {
    affectedComponents: [
      { name: "Git Operations", status: "major_outage", statusLabel: "Major outage" },
      { name: "API Requests", status: "major_outage", statusLabel: "Major outage" },
      { name: "Pull Requests", status: "partial_outage", statusLabel: "Partial outage" },
    ],
    description: "Major System Outage",
    label: "GitHub Outage: 3 services affected",
    tone: "error",
  },
} as const satisfies Readonly<Record<string, GitHubStatusNotice>>;

/** Returns a deterministic notice for local visual testing, or undefined for live status. */
export function resolveGitHubStatusPreview(search: string): GitHubStatusNotice | undefined {
  const preview = new URLSearchParams(search).get(GITHUB_STATUS_PREVIEW_PARAM);
  if (preview !== "partial" && preview !== "major") return undefined;
  return GITHUB_STATUS_PREVIEWS[preview];
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

function affectedServicesLabel(components: ReadonlyArray<GitHubStatusComponentIssue>): string {
  if (components.length === 0) return "service disruption";
  if (components.length <= 2) return components.map((component) => component.name).join(", ");
  return `${components.length} services affected`;
}

export function resolveGitHubStatusNotice(input: unknown): GitHubStatusNotice | null {
  const decoded = decodeGitHubStatusSummary(input);
  if (decoded._tag === "None") return null;

  const summary = decoded.value;
  const affectedComponents = summary.components
    .filter((component) => component.showcase !== false && component.status !== "operational")
    .map(
      (component): GitHubStatusComponentIssue => ({
        name: component.name,
        status: component.status,
        statusLabel: componentStatusLabel(component.status),
      }),
    );

  if (summary.status.indicator === "none" && affectedComponents.length === 0) {
    return null;
  }

  const tone =
    summary.status.indicator === "major" ||
    summary.status.indicator === "critical" ||
    affectedComponents.some((component) => isErrorStatus(component.status))
      ? "error"
      : "warning";

  return {
    affectedComponents,
    description: summary.status.description,
    label: `GitHub Outage: ${affectedServicesLabel(affectedComponents)}`,
    tone,
  };
}
