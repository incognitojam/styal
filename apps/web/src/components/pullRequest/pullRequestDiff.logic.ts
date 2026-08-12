import type { FileDiffMetadata } from "@pierre/diffs";
import type { PullRequestDiffSide } from "@t3tools/contracts";

const IMAGE_FILE_EXTENSION = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;

/** Raster/rich image entries whose host patch contains no source hunks to render. */
export function isPullRequestImageDiff(file: FileDiffMetadata): boolean {
  return file.hunks.length === 0 && IMAGE_FILE_EXTENSION.test(file.name);
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

/** Oversized files stay out of the way, unless a conversation gives the reader a target. */
export function shouldAutoFoldFileDiff(file: FileDiffMetadata, hasAnnotations: boolean): boolean {
  return !hasAnnotations && file.unifiedLineCount > PULL_REQUEST_DIFF_AUTO_FOLD_LINE_THRESHOLD;
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
