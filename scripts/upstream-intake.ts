import type { ForkFeatureLedger } from "./fork-feature-ledger.ts";
import { findForkFeatureOverlaps } from "./fork-feature-ledger.ts";

export interface UpstreamIntakeAuditInput {
  readonly baseSha: string;
  readonly headSha: string;
  readonly commits: ReadonlyArray<string>;
  readonly mergeCommits: ReadonlyArray<string>;
  readonly mainIsAncestor: boolean;
  readonly changedPaths: ReadonlyArray<string>;
  readonly ledger: ForkFeatureLedger;
}

export interface UpstreamIntakeAudit {
  readonly valid: boolean;
  readonly automaticEligible: boolean;
  readonly errors: ReadonlyArray<string>;
  readonly manualReviewReasons: ReadonlyArray<string>;
  readonly overlapFeatureIds: ReadonlyArray<string>;
  readonly summary: string;
}

interface ManualReviewRule {
  readonly description: string;
  readonly matches: (path: string) => boolean;
}

const manualReviewRules: ReadonlyArray<ManualReviewRule> = [
  {
    description: "repository automation or maintainer policy changed",
    matches: (path) => {
      const segments = path.split("/");
      return (
        path === "AGENTS.md" ||
        path.startsWith(".github/") ||
        path.startsWith("packaging/") ||
        segments.includes("scripts")
      );
    },
  },
  {
    description: "dependency or build configuration changed",
    matches: (path) => {
      const fileName = path.split("/").at(-1) ?? path;
      return (
        fileName === "package.json" ||
        fileName === "pnpm-lock.yaml" ||
        fileName === "pnpm-workspace.yaml" ||
        fileName === "Cargo.lock" ||
        fileName === "Cargo.toml" ||
        fileName.endsWith(".config.ts")
      );
    },
  },
  {
    description: "a database migration changed",
    matches: (path) =>
      path
        .toLowerCase()
        .split("/")
        .some((segment) => segment.includes("migration")),
  },
  {
    description: "a cross-surface contract changed",
    matches: (path) => path.startsWith("packages/contracts/"),
  },
  {
    description: "authentication or authorization code changed",
    matches: (path) => {
      const normalized = path.toLowerCase();
      return normalized.includes("/auth") || normalized.includes("/authorization");
    },
  },
  {
    description: "a user-facing client changed and needs surface-specific review",
    matches: (path) =>
      path.startsWith("apps/web/") ||
      path.startsWith("apps/desktop/") ||
      path.startsWith("apps/mobile/"),
  },
];

function abbreviated(sha: string): string {
  return sha.slice(0, 12);
}

export function auditUpstreamIntakeCandidate(input: UpstreamIntakeAuditInput): UpstreamIntakeAudit {
  const errors: Array<string> = [];
  if (!input.mainIsAncestor) errors.push("The candidate is not a fast-forward of main.");
  if (input.commits.length === 0) errors.push("The candidate contains no commits beyond main.");
  if (input.mergeCommits.length > 0) {
    errors.push(`The candidate contains merge commits: ${input.mergeCommits.join(", ")}.`);
  }
  if (input.changedPaths.length === 0) errors.push("The candidate changes no paths beyond main.");

  const overlaps = findForkFeatureOverlaps(input.ledger, input.changedPaths);
  const overlapFeatureIds = overlaps.map(({ feature }) => feature.id);
  const manualReviewReasons = manualReviewRules
    .filter((rule) => input.changedPaths.some(rule.matches))
    .map((rule) => rule.description);
  if (overlapFeatureIds.length > 0) {
    manualReviewReasons.push(`tracked fork feature paths overlap: ${overlapFeatureIds.join(", ")}`);
  }

  const valid = errors.length === 0;
  const automaticEligible = valid && manualReviewReasons.length === 0;
  const promotion = automaticEligible
    ? "Eligible for automatic promotion once the promotion lane is enabled"
    : valid
      ? "Manual approval required"
      : "Blocked";
  const errorSection =
    errors.length === 0
      ? ""
      : `\n## Blocking errors\n\n${errors.map((error) => `- ${error}`).join("\n")}\n`;
  const manualReviewSection =
    manualReviewReasons.length === 0
      ? ""
      : `\n## Manual review reasons\n\n${manualReviewReasons.map((reason) => `- ${reason}`).join("\n")}\n`;
  const overlapSection =
    overlaps.length === 0
      ? "\n## Fork feature overlap\n\nNo tracked fork feature upstream paths changed.\n"
      : `\n## Fork feature overlap\n\n${overlaps
          .map(
            ({ feature, paths }) =>
              `- \`${feature.id}\`: ${feature.title} — ${paths.map((path) => `\`${path}\``).join(", ")}`,
          )
          .join("\n")}\n`;
  const summary = `# Upstream intake audit

| Field | Value |
| --- | --- |
| Base | \`${abbreviated(input.baseSha)}\` |
| Candidate | \`${abbreviated(input.headSha)}\` |
| Commits | ${input.commits.length} |
| Changed paths | ${input.changedPaths.length} |
| Decision | ${promotion} |
${errorSection}${manualReviewSection}${overlapSection}
> This audit is report-only. It does not update \`main\`.
`;

  return {
    valid,
    automaticEligible,
    errors,
    manualReviewReasons,
    overlapFeatureIds,
    summary,
  };
}
