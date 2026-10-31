import { type IntakeState, type Integration, type QueueEntry, reconcile } from "../queue.ts";
import type { TrackedPR } from "./tracked-prs.ts";

const EARLY_IMPORT_TRAILER = /^Early-Import:[\t ]*\S/mu;

/** Whether a commit declares its upstream sources an intentional import ahead of the queue. */
function declaresEarlyImport(message: string): boolean {
  return EARLY_IMPORT_TRAILER.test(message);
}

interface ForkCommit {
  readonly sha: string;
  readonly message: string;
}

export interface QueueOrderInput {
  /** The baseline..target queue, with upstream PRs associated. */
  readonly integrations: Integration[];
  readonly mainCommits: ReadonlyArray<ForkCommit>;
  readonly candidateCommits: ReadonlyArray<ForkCommit>;
  readonly exceptions: IntakeState["exceptions"];
  readonly mainTracked: readonly TrackedPR[];
  readonly candidateTracked: readonly TrackedPR[];
}

export interface QueueOrderGap {
  /** Entries still pending on the candidate that precede a source it records in order. */
  readonly skipped: ReadonlyArray<QueueEntry>;
  /** Candidate commits without `Early-Import` that record a source after the first skipped entry. */
  readonly laterCommits: ReadonlyArray<ForkCommit>;
}

/**
 * Pending queue entries the candidate leaves behind while recording later
 * ones. Sources recorded by a commit with an `Early-Import` trailer do not
 * count as in-order progress; recorded, skipped, and already-present entries
 * are accounted for.
 */
export function queueOrderGap(input: QueueOrderInput): QueueOrderGap {
  const recordedBy = (commits: ReadonlyArray<ForkCommit>, tracked: readonly TrackedPR[]) =>
    reconcile(input.integrations, [...commits], input.exceptions, tracked);
  const before = recordedBy(input.mainCommits, input.mainTracked);
  const after = recordedBy(
    [...input.candidateCommits, ...input.mainCommits],
    input.candidateTracked,
  );
  const early = reconcile(
    input.integrations,
    input.candidateCommits.filter((commit) => declaresEarlyImport(commit.message)),
    {},
    input.candidateTracked,
  );
  const advancesInOrder = (index: number) =>
    before[index]!.disposition === "pending" &&
    after[index]!.disposition === "recorded" &&
    early[index]!.disposition !== "recorded";
  const last = after.findLastIndex((_, index) => advancesInOrder(index));
  const skipped = after
    .slice(0, Math.max(last, 0))
    .filter((entry) => entry.disposition === "pending");
  if (skipped.length === 0) return { skipped, laterCommits: [] };
  const first = after.indexOf(skipped[0]!);
  const laterCommits = input.candidateCommits.filter(
    (commit) =>
      !declaresEarlyImport(commit.message) &&
      reconcile(input.integrations, [commit], {}, input.candidateTracked).some(
        (entry, index) =>
          index > first && entry.disposition === "recorded" && advancesInOrder(index),
      ),
  );
  return { skipped, laterCommits };
}

const LISTED = 10;

function listed<A>(items: ReadonlyArray<A>, label: (item: A) => string): string {
  const shown = items.slice(0, LISTED).map(label);
  if (items.length > LISTED) shown.push(`and ${items.length - LISTED} more`);
  return shown.join("; ");
}

export function queueOrderError(gap: QueueOrderGap): string | null {
  if (gap.skipped.length === 0) return null;
  const subject = (message: string) => message.split(/\r?\n/u)[0] ?? "";
  const later =
    gap.laterCommits.length === 0
      ? ""
      : ` Candidate commits that record later sources: ${listed(gap.laterCommits, (commit) => `${commit.sha.slice(0, 12)} ${subject(commit.message)}`)}.`;
  return `The candidate leaves ${gap.skipped.length} earlier pending queue ${gap.skipped.length === 1 ? "entry" : "entries"} behind while recording later ones: ${listed(
    gap.skipped,
    (entry) =>
      `${entry.sha.slice(0, 12)} ${entry.pr === null ? "direct commit" : `#${entry.pr}`} ${entry.title}`,
  )}.${later} Apply the skipped entries first, or record a skip or already-present exception for them in .github/upstream-intake.json through a state-only PR. For an intentional early import, add an \`Early-Import: <reason>\` trailer to each commit that imports the early source.`;
}
