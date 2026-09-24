import type { QueueEntry } from "./upstream-queue.ts";
import { parseUpstreamProvenance, withoutFencedExamples } from "./upstream-provenance.ts";

export interface TrackedPR {
  readonly number: number;
}

export interface TrackedPRMetadata {
  readonly number: number;
  readonly title: string;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly mergedAt: string | null;
  readonly mergeCommit: { readonly oid: string } | null;
}

export interface TrackedPRStatus extends TrackedPR {
  readonly title: string;
  readonly mergedAt: string | null;
  readonly status: "open" | "closed" | "pending" | "recorded" | "skipped" | "fetch upstream";
  readonly daysAheadOfTip: number | null;
  readonly beyondTarget: boolean;
}

export function fetchTrackedPRMetadata(
  repository: string,
  tracked: readonly TrackedPR[],
  run: (command: string, args: string[]) => string,
): readonly TrackedPRMetadata[] {
  const [owner, name] = repository.split("/");
  const result: TrackedPRMetadata[] = [];
  for (let start = 0; start < tracked.length; start += 40) {
    const batch = tracked.slice(start, start + 40);
    const query = `query { repository(owner:${JSON.stringify(owner)}, name:${JSON.stringify(name)}) { ${batch.map((pr, index) => `p${index}: pullRequest(number:${pr.number}) { number title state mergedAt mergeCommit { oid } }`).join(" ")} } }`;
    const response = JSON.parse(run("gh", ["api", "graphql", "-f", `query=${query}`])) as {
      errors?: unknown;
      data?: { repository?: Record<string, TrackedPRMetadata | null> };
    };
    if (response.errors || !response.data?.repository)
      throw new Error("Could not read tracked upstream PR metadata.");
    batch.forEach((pr, index) => {
      const metadata = response.data!.repository![`p${index}`];
      if (!metadata || metadata.number !== pr.number)
        throw new Error(`Could not find tracked upstream PR #${pr.number}.`);
      result.push(metadata);
    });
  }
  return result;
}

export function decodeTrackedPRs(input: string): readonly TrackedPR[] {
  const document = JSON.parse(input) as { pullRequests?: unknown };
  if (!document || !Array.isArray(document.pullRequests))
    throw new Error("Invalid tracked PRs: expected a pullRequests array.");
  const seen = new Set<number>();
  return document.pullRequests.map((entry: unknown) => {
    if (!Number.isSafeInteger(entry) || (entry as number) < 1 || seen.has(entry as number))
      throw new Error(`Invalid or duplicate tracked PR: ${String(entry)}.`);
    seen.add(entry as number);
    return { number: entry as number };
  });
}

export function trackedPRStatuses(input: {
  readonly tracked: readonly TrackedPR[];
  readonly metadata: readonly TrackedPRMetadata[];
  readonly entries: readonly QueueEntry[];
  readonly forkCommits: readonly { sha: string; message: string }[];
  readonly upstreamFirstParent: ReadonlySet<string>;
  readonly targetFirstParent: ReadonlySet<string>;
  readonly baselineFirstParent: ReadonlySet<string>;
  readonly exceptions: Readonly<
    Record<string, { readonly disposition: "already present" | "skip" | "pending" }>
  >;
  readonly tipMergedAt: number;
}): readonly TrackedPRStatus[] {
  const metadata = new Map(input.metadata.map((pr) => [pr.number, pr]));
  return input.tracked.map((tracked) => {
    const pr = metadata.get(tracked.number);
    if (!pr) throw new Error(`Missing upstream metadata for tracked PR #${tracked.number}.`);
    if (pr.state !== "MERGED" || !pr.mergedAt || !pr.mergeCommit) {
      return {
        ...tracked,
        title: pr.title,
        mergedAt: null,
        status: pr.state === "OPEN" ? "open" : "closed",
        daysAheadOfTip: null,
        beyondTarget: false,
      };
    }
    const sha = pr.mergeCommit.oid;
    const exception = input.exceptions[sha]?.disposition;
    const inTarget = input.targetFirstParent.has(sha);
    const inUpstream = input.upstreamFirstParent.has(sha);
    const entries = input.entries.filter((entry) => entry.pr === tracked.number);
    const recorded = input.forkCommits.some((commit) => {
      if (commit.sha === sha) return true;
      const provenance = parseUpstreamProvenance([commit.message]);
      if (provenance.errors.length)
        throw new Error(`${commit.sha}: ${provenance.errors.join(" ")}`);
      return (
        provenance.pullRequestNumbers.includes(tracked.number) ||
        provenance.commitShas.includes(sha) ||
        withoutFencedExamples(commit.message).includes(`(cherry picked from commit ${sha})`)
      );
    });
    const status =
      exception === "pending" || entries.some((entry) => entry.disposition === "pending")
        ? "pending"
        : exception === "skip" || entries.some((entry) => entry.disposition === "skip")
          ? "skipped"
          : exception === "already present" ||
              recorded ||
              input.baselineFirstParent.has(sha) ||
              entries.length > 0
            ? "recorded"
            : inUpstream
              ? "pending"
              : "fetch upstream";
    return {
      ...tracked,
      title: pr.title,
      mergedAt: pr.mergedAt,
      status,
      daysAheadOfTip:
        status === "pending"
          ? Math.max(0, (Date.parse(pr.mergedAt) - input.tipMergedAt) / 86_400_000)
          : null,
      beyondTarget: inUpstream && !inTarget,
    };
  });
}
