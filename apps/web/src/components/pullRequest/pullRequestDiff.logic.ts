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

/** Past this height, one file stops being a useful part of the surrounding scroll. */
export const PULL_REQUEST_DIFF_AUTO_FOLD_LINE_THRESHOLD = 1_200;

/**
 * Oversized and generated files stay out of the way, unless a conversation gives the reader a
 * target.
 */
export function shouldAutoFoldFileDiff(
  file: FileDiffMetadata,
  hasAnnotations: boolean,
  generatedPaths?: ReadonlySet<string>,
): boolean {
  return (
    !hasAnnotations &&
    (diffFileTier(file.name ?? file.prevName ?? "", generatedPaths) === "generated" ||
      file.unifiedLineCount > PULL_REQUEST_DIFF_AUTO_FOLD_LINE_THRESHOLD)
  );
}

/**
 * Whether a file is drawn folded.
 *
 * A diff arrives a slice at a time, so the toolbar's choice is kept as the default that later
 * files inherit. Per-file choices are explicit answers: an annotation can change an oversized
 * file's automatic default without reversing what the reader already chose. Ordinary files start
 * open while individually oversized files start folded.
 */
export function isFileDiffCollapsed(
  fileKey: string,
  foldOverride: DiffFoldOverride,
  fileFoldOverrides: ReadonlyMap<string, boolean>,
  autoFolded = false,
): boolean {
  const fileOverride = fileFoldOverrides.get(fileKey);
  if (fileOverride !== undefined) return fileOverride;
  const foldedByDefault = foldOverride === null ? autoFolded : foldOverride === "folded";
  return foldedByDefault;
}
