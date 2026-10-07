import type { FileDiffMetadata } from "@pierre/diffs";
import type { PullRequestDiffSide, PullRequestOmittedFileStat } from "@t3tools/contracts";
import { diffFileTier } from "@t3tools/shared/diffFileOrder";

export interface PullRequestDiffSlice {
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

/**
 * Whether a conversation's line is really in this file's hunks.
 *
 * A thread naming a file is not the same as a thread the diff can show: its line may have moved
 * out of the change, or sit in a hunk the host withheld. Pinning it anyway would put the remark
 * against whatever code now occupies that line number, and silently dropping it would lose the
 * conversation, so the answer decides which of the two lists it belongs in.
 */
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

/** What the toolbar last asked of every file at once, null being the reader asking nothing yet. */
export type DiffFoldOverride = "expanded" | "folded" | null;

/**
 * The fold a file starts from, before the reader toggles it: the toolbar's last choice, or else
 * the saved default. When the saved default opens files, generated files such as lockfiles still
 * start folded. `generatedPaths` carries the repository's `linguist-generated` attributions.
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

/**
 * Whether a file is drawn folded.
 *
 * A diff arrives a slice at a time, so the reader's own choices are kept as the difference from
 * what the toolbar last said rather than as the set of folded files: a file that has not loaded
 * yet cannot be in a set, and would otherwise land expanded moments after the reader folded
 * everything. The caller supplies the saved default until the toolbar overrides it; individual
 * files can still be toggled independently.
 */
export function isFileDiffCollapsed(
  fileKey: string,
  foldOverride: DiffFoldOverride,
  toggledFileKeys: ReadonlySet<string>,
): boolean {
  const foldedByDefault = foldOverride === "folded";
  return toggledFileKeys.has(fileKey) ? !foldedByDefault : foldedByDefault;
}

/**
 * The reader's fold choices after a file was ticked off, or put back.
 *
 * Clearing a file puts it away and un-clearing brings it back, so the tick moves the fold as if
 * the reader had pressed the chevron themselves, which keeps folding a difference from what the
 * toolbar last asked, and so keeps "collapse all" from ticking anything off.
 */
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
