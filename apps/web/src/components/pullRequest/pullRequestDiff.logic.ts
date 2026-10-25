import type { FileDiffMetadata } from "@pierre/diffs";
import type { PullRequestDiffSide, PullRequestOmittedFileStat } from "@t3tools/contracts";
import { diffFileTier } from "@t3tools/shared/diffFileOrder";

export interface PullRequestDiffSlice {
  readonly source?: object;
  readonly cursor: string | null;
  readonly patch: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly omittedFileStats: ReadonlyArray<PullRequestOmittedFileStat>;
  readonly generatedPaths: ReadonlyArray<string>;
}

export interface PullRequestDiffSliceState {
  readonly key: string;
  readonly cursor: string | null;
  readonly slices: ReadonlyArray<PullRequestDiffSlice>;
  readonly refreshing: boolean;
}

/** Reconcile one page without mixing continuation cursors from two diff snapshots. */
export function applyPullRequestDiffPage(
  previous: PullRequestDiffSliceState,
  scopeKey: string,
  cursor: string | null,
  next: PullRequestDiffSlice,
  waiting: boolean,
): PullRequestDiffSliceState {
  // Atom.swr may expose the old page while the replacement request is pending.
  if (previous.key === scopeKey && previous.refreshing && waiting) return previous;
  const slices = previous.key === scopeKey ? previous.slices : [];
  const index = slices.findIndex((slice) => slice.cursor === cursor);
  if (index === -1) {
    return { key: scopeKey, cursor, slices: [...slices, next], refreshing: false };
  }
  const existing = slices[index];
  if (
    existing !== undefined &&
    existing.patch === next.patch &&
    existing.truncated === next.truncated &&
    existing.nextCursor === next.nextCursor &&
    existing.generatedPaths.length === next.generatedPaths.length &&
    existing.generatedPaths.every((path, index) => next.generatedPaths[index] === path) &&
    existing.omittedFileStats.length === next.omittedFileStats.length &&
    existing.omittedFileStats.every((file, index) => {
      const refreshed = next.omittedFileStats[index];
      return (
        refreshed !== undefined &&
        refreshed.path === file.path &&
        refreshed.additions === file.additions &&
        refreshed.deletions === file.deletions
      );
    })
  ) {
    return previous.refreshing ? { ...previous, refreshing: false } : previous;
  }
  return { key: scopeKey, cursor, slices: [...slices.slice(0, index), next], refreshing: false };
}

/** Only rendered hunks can anchor comments; list others off-diff. */
export function isLineInFileDiff(
  file: FileDiffMetadata,
  side: PullRequestDiffSide,
  line: number,
): boolean {
  return file.hunks.some((hunk) =>
    side === "left"
      ? line >= hunk.deletionStart && line < hunk.deletionStart + hunk.deletionCount
      : line >= hunk.additionStart && line < hunk.additionStart + hunk.additionCount,
  );
}

export type DiffFoldOverride = "expanded" | "folded" | null;

/**
 * When the saved default opens files, generated files such as lockfiles still start folded.
 * `generatedPaths` carries the repository's `linguist-generated` attributions.
 */
export function fileDiffFoldDefault(
  path: string,
  foldOverride: DiffFoldOverride,
  diffFilesCollapsed: boolean,
  generatedPaths: ReadonlySet<string>,
): DiffFoldOverride {
  if (foldOverride !== null) return foldOverride;
  return diffFilesCollapsed || diffFileTier(path, generatedPaths) === "generated"
    ? "folded"
    : "expanded";
}

/** Keep fold choices relative to the toolbar so later pages inherit Fold all. */
export function isFileDiffCollapsed(
  fileKey: string,
  foldOverride: DiffFoldOverride,
  toggledFileKeys: ReadonlySet<string>,
): boolean {
  const foldedByDefault = foldOverride === "folded";
  return toggledFileKeys.has(fileKey) ? !foldedByDefault : foldedByDefault;
}

export function toggleFileDiffFoldForViewed(
  fileKey: string,
  viewed: boolean,
  foldOverride: DiffFoldOverride,
  toggledFileKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  if (isFileDiffCollapsed(fileKey, foldOverride, toggledFileKeys) === viewed)
    return toggledFileKeys;
  const next = new Set(toggledFileKeys);
  if (next.has(fileKey)) next.delete(fileKey);
  else next.add(fileKey);
  return next;
}
