import type { QueueEntry } from "./upstream-queue.ts";

export interface EarlyCandidate {
  pr: number;
  commits: string[];
  precedingPRs: number;
  overlappingPaths: string[];
  cleanApply: boolean | null;
  fileDisjointAndClean: boolean;
  reason: string | null;
}

const pathsCollide = (left: string, right: string) =>
  left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

export interface EarlyImportSelection {
  requestedPRs: number[];
  selected: QueueEntry[];
  intervening: QueueEntry[];
}

/**
 * Position of the reconciled boundary in `entries`, which start after the
 * baseline. Until the first entry is reconciled the boundary is the baseline
 * itself, which sits before every entry.
 */
function boundaryIndex(entries: QueueEntry[], baseline: string, through: string): number {
  if (through === baseline) return -1;
  const index = entries.findIndex((entry) => entry.sha === through);
  if (index < 0) throw new Error("Reconciled boundary is outside the upstream target.");
  return index;
}

/** Select whole pending PRs and every upstream integration before the last source. */
export function selectEarlySources(
  entries: QueueEntry[],
  baseline: string,
  through: string,
  requestedPRs: readonly number[],
  directCommits: readonly string[] = [],
): EarlyImportSelection {
  const start = boundaryIndex(entries, baseline, through);
  const outstanding = entries.slice(start + 1);
  const requested = [...new Set(requestedPRs)];
  for (const pr of requested) {
    if (!outstanding.some((entry) => entry.pr === pr && entry.disposition === "pending"))
      throw new Error(`PR #${pr} is not pending after the reconciled boundary.`);
  }
  for (const sha of directCommits) {
    if (
      !outstanding.some(
        (entry) => entry.sha === sha && entry.pr === null && entry.disposition === "pending",
      )
    )
      throw new Error(`Direct commit ${sha} is not pending after the reconciled boundary.`);
  }
  const isSelected = (entry: QueueEntry) =>
    entry.disposition === "pending" &&
    ((entry.pr !== null && requested.includes(entry.pr)) || directCommits.includes(entry.sha));
  const last = outstanding.findLastIndex(isSelected);
  const selected = outstanding.filter((entry) => isSelected(entry));
  return {
    requestedPRs: requested,
    selected,
    intervening: outstanding.slice(0, last + 1),
  };
}

/**
 * Pending sources between the reconciled boundary and `blocked` that change
 * any of `paths`: the earlier upstream work a selected source needs when it
 * does not apply at the boundary.
 */
export function earlierSourcesTouching(
  entries: QueueEntry[],
  baseline: string,
  through: string,
  blocked: QueueEntry,
  paths: readonly string[],
  changedPaths: (entry: QueueEntry) => readonly string[],
): QueueEntry[] {
  const start = boundaryIndex(entries, baseline, through);
  const end = entries.findIndex((entry) => entry.sha === blocked.sha);
  return entries
    .slice(start + 1, end)
    .filter(
      (entry) =>
        entry.disposition === "pending" &&
        changedPaths(entry).some((path) =>
          paths.some((blockedPath) => pathsCollide(path, blockedPath)),
        ),
    );
}

/** Add only sources that actually conflict in an upstream-order replay. */
export function resolveEarlyDependencies(
  entries: QueueEntry[],
  baseline: string,
  through: string,
  requestedPRs: readonly number[],
  firstConflict: (selection: EarlyImportSelection) => QueueEntry | null,
) {
  const dependencies = new Set<number>();
  const directCommits = new Set<string>();
  for (let attempt = 0; attempt <= entries.length; attempt++) {
    const selection = selectEarlySources(
      entries,
      baseline,
      through,
      [...requestedPRs, ...dependencies],
      [...directCommits],
    );
    const conflict = firstConflict(selection);
    if (conflict === null) {
      return {
        requestedPRs: [...new Set(requestedPRs)],
        dependencyPRs: [...dependencies],
        dependencyCommits: [...directCommits],
        selected: selection.selected,
        replayedCommits: selection.intervening.length,
        attempts: attempt + 1,
      };
    }
    if (conflict.disposition !== "pending")
      throw new Error(`Replay conflicts with already recorded source ${conflict.sha}.`);
    if (conflict.pr === null) {
      if (directCommits.has(conflict.sha)) throw new Error(`Repeated conflict at ${conflict.sha}.`);
      directCommits.add(conflict.sha);
    } else {
      if (requestedPRs.includes(conflict.pr) || dependencies.has(conflict.pr))
        throw new Error(`Repeated conflict at PR #${conflict.pr}.`);
      dependencies.add(conflict.pr);
    }
  }
  throw new Error("Could not resolve early intake dependencies.");
}

/** A conservative file-level screen for taking a PR ahead of pending intake. */
export function assessEarlyCandidates(
  entries: QueueEntry[],
  baseline: string,
  through: string,
  count: number,
  selectedPR: number | null,
  changedPaths: (entry: QueueEntry) => readonly string[],
  appliesCleanly: (entry: QueueEntry) => boolean,
): EarlyCandidate[] {
  const start = boundaryIndex(entries, baseline, through);
  const outstanding = entries.slice(start + 1).filter((entry) => entry.disposition === "pending");
  const byPR = new Map<number, QueueEntry[]>();
  for (const entry of outstanding) {
    if (entry.pr === null) continue;
    byPR.set(entry.pr, [...(byPR.get(entry.pr) ?? []), entry]);
  }
  if (selectedPR !== null && !byPR.has(selectedPR))
    throw new Error(`PR #${selectedPR} is not pending after the reconciled boundary.`);

  const earlierPaths = new Set<string>();
  const earlierPRs = new Set<number>();
  const results: EarlyCandidate[] = [];
  const seen = new Set<number>();
  for (const entry of outstanding) {
    if (entry.pr !== null && !seen.has(entry.pr)) {
      seen.add(entry.pr);
      if (selectedPR === null || selectedPR === entry.pr) {
        const sources = byPR.get(entry.pr)!;
        const paths = new Set(sources.flatMap((source) => [...changedPaths(source)]));
        const previousPaths = [...earlierPaths];
        const overlappingPaths = [...paths]
          .filter((path) => previousPaths.some((earlier) => pathsCollide(path, earlier)))
          .sort();
        const reason =
          sources.length !== 1
            ? "Multi-commit PR: clean application requires sequential simulation."
            : sources[0]!.empty
              ? "Empty first-parent diff: inspect source history."
              : null;
        const cleanApply = reason === null ? appliesCleanly(sources[0]!) : null;
        results.push({
          pr: entry.pr,
          commits: sources.map((source) => source.sha),
          precedingPRs: earlierPRs.size,
          overlappingPaths,
          cleanApply,
          fileDisjointAndClean: cleanApply === true && overlappingPaths.length === 0,
          reason,
        });
      }
      if (selectedPR === null && results.length === count) break;
      if (selectedPR !== null && selectedPR === entry.pr) break;
    }
    for (const path of changedPaths(entry)) earlierPaths.add(path);
    if (entry.pr !== null) earlierPRs.add(entry.pr);
  }
  return results;
}
