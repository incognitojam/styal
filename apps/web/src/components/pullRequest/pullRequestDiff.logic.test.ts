import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  isFileDiffCollapsed,
  isLineInFileDiff,
  isPullRequestImageDiff,
  PULL_REQUEST_DIFF_AUTO_FOLD_LINE_THRESHOLD,
  shouldAutoFoldFileDiff,
} from "./pullRequestDiff.logic";

/** Only the hunk ranges matter here; the viewer fills the rest in when it renders. */
function fileWithHunks(
  hunks: ReadonlyArray<{
    deletionStart: number;
    deletionCount: number;
    additionStart: number;
    additionCount: number;
  }>,
): FileDiffMetadata {
  return { name: "src/app.ts", hunks } as unknown as FileDiffMetadata;
}

describe("isLineInFileDiff", () => {
  const file = fileWithHunks([
    { deletionStart: 10, deletionCount: 3, additionStart: 10, additionCount: 5 },
    { deletionStart: 40, deletionCount: 0, additionStart: 42, additionCount: 2 },
  ]);

  it("places a line inside a hunk, on the side that hunk counts", () => {
    expect(isLineInFileDiff(file, "right", 12)).toBe(true);
    expect(isLineInFileDiff(file, "left", 11)).toBe(true);
  });

  it("includes the first line of a hunk and excludes the one past its last", () => {
    // The boundaries are where an off-by-one would quietly move a conversation between lists.
    expect(isLineInFileDiff(file, "right", 10)).toBe(true);
    expect(isLineInFileDiff(file, "right", 14)).toBe(true);
    expect(isLineInFileDiff(file, "right", 15)).toBe(false);
    expect(isLineInFileDiff(file, "left", 9)).toBe(false);
    expect(isLineInFileDiff(file, "left", 12)).toBe(true);
    expect(isLineInFileDiff(file, "left", 13)).toBe(false);
  });

  it("keeps the two sides apart, since one line number means two lines", () => {
    // The second hunk is a pure insertion: it deletes nothing, so nothing is on its left.
    expect(isLineInFileDiff(file, "right", 43)).toBe(true);
    expect(isLineInFileDiff(file, "left", 40)).toBe(false);
  });

  it("places nothing in a file whose hunks the host withheld", () => {
    expect(isLineInFileDiff(fileWithHunks([]), "right", 1)).toBe(false);
  });
});

describe("isFileDiffCollapsed", () => {
  const NO_OVERRIDES: ReadonlyMap<string, boolean> = new Map();

  it("opens every file before the reader has touched anything", () => {
    expect(isFileDiffCollapsed("a.ts", null, NO_OVERRIDES)).toBe(false);
    expect(isFileDiffCollapsed("b.ts", null, NO_OVERRIDES)).toBe(false);
  });

  it("opens every file once the toolbar has asked for it", () => {
    // Pressing the toolbar clears the reader's per-file overrides, which is why the map is empty.
    expect(isFileDiffCollapsed("a.ts", "expanded", NO_OVERRIDES)).toBe(false);
    expect(isFileDiffCollapsed("b.ts", "expanded", NO_OVERRIDES)).toBe(false);
  });

  it("folds every file again on the second press", () => {
    expect(isFileDiffCollapsed("a.ts", "folded", NO_OVERRIDES)).toBe(true);
    expect(isFileDiffCollapsed("b.ts", "folded", NO_OVERRIDES)).toBe(true);
  });

  it("keeps a file the reader folded closed as the next slice arrives", () => {
    // The file keys grow with every slice, so the answer for one already folded must not depend
    // on how many of them there are by then.
    const overrides = new Map([["b.ts", true]]);
    expect(isFileDiffCollapsed("b.ts", null, overrides)).toBe(true);
    expect(isFileDiffCollapsed("c.ts", null, overrides)).toBe(false);
  });

  it("keeps a later per-file override ahead of either toolbar choice", () => {
    expect(isFileDiffCollapsed("a.ts", "expanded", new Map([["a.ts", true]]))).toBe(true);
    expect(isFileDiffCollapsed("a.ts", "folded", new Map([["a.ts", false]]))).toBe(false);
  });

  it("starts an oversized file folded until the reader opens it", () => {
    expect(isFileDiffCollapsed("large.ts", null, NO_OVERRIDES, true)).toBe(true);
    expect(isFileDiffCollapsed("large.ts", null, new Map([["large.ts", false]]), true)).toBe(false);
  });

  it("lets the toolbar override an oversized file's automatic fold", () => {
    expect(isFileDiffCollapsed("large.ts", "expanded", NO_OVERRIDES, true)).toBe(false);
    expect(isFileDiffCollapsed("small.ts", "folded", NO_OVERRIDES, false)).toBe(true);
  });

  it("does not reverse a manual choice when the automatic default changes", () => {
    const opened = new Map([["large.ts", false]]);
    expect(isFileDiffCollapsed("large.ts", null, opened, true)).toBe(false);
    expect(isFileDiffCollapsed("large.ts", null, opened, false)).toBe(false);
  });
});

describe("shouldAutoFoldFileDiff", () => {
  const fileWithLineCount = (unifiedLineCount: number) =>
    ({ unifiedLineCount }) as FileDiffMetadata;

  it("folds only files taller than the automatic limit", () => {
    expect(
      shouldAutoFoldFileDiff(fileWithLineCount(PULL_REQUEST_DIFF_AUTO_FOLD_LINE_THRESHOLD), false),
    ).toBe(false);
    expect(
      shouldAutoFoldFileDiff(
        fileWithLineCount(PULL_REQUEST_DIFF_AUTO_FOLD_LINE_THRESHOLD + 1),
        false,
      ),
    ).toBe(true);
  });

  it("keeps an oversized file open when it carries a review annotation", () => {
    expect(
      shouldAutoFoldFileDiff(
        fileWithLineCount(PULL_REQUEST_DIFF_AUTO_FOLD_LINE_THRESHOLD + 1),
        true,
      ),
    ).toBe(false);
  });
});

describe("isPullRequestImageDiff", () => {
  it("recognizes supported image files whose patch has no hunks", () => {
    expect(isPullRequestImageDiff({ name: "screenshots/App.PNG", hunks: [] } as never)).toBe(true);
    expect(isPullRequestImageDiff({ name: "icons/mark.svg", hunks: [] } as never)).toBe(true);
  });

  it("leaves textual image patches and other binary files with the code viewer", () => {
    expect(isPullRequestImageDiff({ name: "icons/mark.svg", hunks: [{}] } as never)).toBe(false);
    expect(isPullRequestImageDiff({ name: "fixtures/archive.zip", hunks: [] } as never)).toBe(
      false,
    );
  });
});
