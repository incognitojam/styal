import type { PullRequestCheck, PullRequestChecks, PullRequestDetail } from "@t3tools/contracts";

export function resolvePullRequestDetailChecks(
  detail: PullRequestDetail | null,
  checks: PullRequestChecks | null,
  checksAreNewer: boolean,
): PullRequestDetail | null {
  if (detail === null || checks === null) return detail;
  const newer =
    detail.observedAt !== undefined && checks.observedAt !== undefined
      ? checks.observedAt >= detail.observedAt
      : checksAreNewer;
  return newer
    ? {
        ...detail,
        state: detail.state === "merged" ? "merged" : checks.state,
        checks: withDetailRequiredChecks(detail.checks, checks.checks),
      }
    : detail;
}

// The checks read skips the host's required-check and branch-policy queries to keep
// refreshes cheap, so required-ness and not-yet-reported required rows come from detail.
function withDetailRequiredChecks(
  detailChecks: ReadonlyArray<PullRequestCheck>,
  checks: ReadonlyArray<PullRequestCheck>,
): ReadonlyArray<PullRequestCheck> {
  const requiredNames = new Set(
    detailChecks.flatMap((check) => (check.required === true ? [check.name] : [])),
  );
  if (requiredNames.size === 0) return checks;
  const reportedNames = new Set(checks.map((check) => check.name));
  return [
    ...checks.map((check) =>
      requiredNames.has(check.name) && check.required !== true
        ? { ...check, required: true }
        : check,
    ),
    ...detailChecks.filter(
      (check) =>
        check.required === true && check.status === "expected" && !reportedNames.has(check.name),
    ),
  ];
}

/** Checks still running are worth a tighter poll than a settled head. */
export function pullRequestChecksRefreshIntervalMs(
  checks: ReadonlyArray<PullRequestCheck>,
): number {
  return checks.length === 0 ||
    checks.some((check) => check.status === "pending" || check.status === "action-required")
    ? 45_000
    : 60_000;
}
