import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  applyPullRequestDiffPage,
  fileDiffFoldDefault,
  isFileDiffCollapsed,
  isLineInFileDiff,
  toggleFileDiffFoldForViewed,
  type PullRequestDiffSlice,
} from "./pullRequestDiff.logic";

describe("diff page refresh", () => {
  const first: PullRequestDiffSlice = {
    cursor: null,
    patch: "first file",
    truncated: false,
    nextCursor: "page-2",
    omittedFileStats: [],
    generatedPaths: [],
  };
  const second: PullRequestDiffSlice = {
    ...first,
    cursor: "page-2",
    patch: "second file",
    nextCursor: null,
  };
  const refreshing = {
    key: "project:pr-1",
    cursor: null,
    slices: [first, second],
    refreshing: true,
  };

  it("keeps the complete old diff visible while the first page is pending", () => {
    expect(applyPullRequestDiffPage(refreshing, refreshing.key, null, first, true)).toBe(
      refreshing,
    );
  });

  it("keeps later pages when the refreshed first page is unchanged", () => {
    const result = applyPullRequestDiffPage(refreshing, refreshing.key, null, first, false);
    expect(result.slices).toBe(refreshing.slices);
    expect(result.refreshing).toBe(false);
  });

  it("drops old continuation pages when the refreshed first page changes", () => {
    const changed = { ...first, patch: "new first file", nextCursor: "new-page-2" };
    const result = applyPullRequestDiffPage(refreshing, refreshing.key, null, changed, false);
    expect(result.slices).toEqual([changed]);
    expect(result.refreshing).toBe(false);
  });
});

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

  it("includes the first line of a hunk and excludes the one past its last", () => {
    expect(isLineInFileDiff(file, "right", 10)).toBe(true);
    expect(isLineInFileDiff(file, "right", 14)).toBe(true);
    expect(isLineInFileDiff(file, "right", 15)).toBe(false);
    expect(isLineInFileDiff(file, "left", 9)).toBe(false);
    expect(isLineInFileDiff(file, "left", 12)).toBe(true);
    expect(isLineInFileDiff(file, "left", 13)).toBe(false);
  });

  it("keeps the two sides apart, since one line number means two lines", () => {
    expect(isLineInFileDiff(file, "right", 43)).toBe(true);
    expect(isLineInFileDiff(file, "left", 40)).toBe(false);
  });
});

describe("isFileDiffCollapsed", () => {
  it("keeps a file the reader folded closed as the next slice arrives", () => {
    const toggled = new Set(["b.ts"]);
    expect(isFileDiffCollapsed("b.ts", null, toggled)).toBe(true);
    expect(isFileDiffCollapsed("c.ts", null, toggled)).toBe(false);
  });
});

describe("toggleFileDiffFoldForViewed", () => {
  it("puts a file away when it is ticked off", () => {
    expect([...toggleFileDiffFoldForViewed("a.ts", true, null, new Set())]).toEqual(["a.ts"]);
  });

  it("moves against whatever the toolbar last asked for", () => {
    expect([...toggleFileDiffFoldForViewed("a.ts", true, "expanded", new Set())]).toEqual(["a.ts"]);
    expect(toggleFileDiffFoldForViewed("a.ts", false, "expanded", new Set()).size).toBe(0);
  });

  it("touches only the file that was ticked", () => {
    const toggled = new Set(["a.ts", "b.ts"]);
    expect([...toggleFileDiffFoldForViewed("a.ts", false, null, toggled)]).toEqual(["b.ts"]);
  });
});

describe("fileDiffFoldDefault", () => {
  const NO_ATTRIBUTIONS: ReadonlySet<string> = new Set();
  const NO_TOGGLES: ReadonlySet<string> = new Set();
  const collapsedWhenOpening = (path: string, generatedPaths = NO_ATTRIBUTIONS) =>
    isFileDiffCollapsed(path, fileDiffFoldDefault(path, null, false, generatedPaths), NO_TOGGLES);

  it("folds lockfiles and build output when files open expanded", () => {
    expect(collapsedWhenOpening("src/app.ts")).toBe(false);
    expect(collapsedWhenOpening("pnpm-lock.yaml")).toBe(true);
    expect(collapsedWhenOpening("packages/app/dist/index.js")).toBe(true);
  });

  it("folds a file the repository attributes as generated, whatever its name", () => {
    expect(collapsedWhenOpening("src/schema.ts", new Set(["src/schema.ts"]))).toBe(true);
  });

  it("folds every file when files open collapsed", () => {
    expect(fileDiffFoldDefault("src/app.ts", null, true, NO_ATTRIBUTIONS)).toBe("folded");
    expect(fileDiffFoldDefault("pnpm-lock.yaml", null, true, NO_ATTRIBUTIONS)).toBe("folded");
  });

  it("opens a folded lockfile the reader toggles", () => {
    const foldDefault = fileDiffFoldDefault("pnpm-lock.yaml", null, false, NO_ATTRIBUTIONS);
    expect(isFileDiffCollapsed("pnpm-lock.yaml", foldDefault, new Set(["pnpm-lock.yaml"]))).toBe(
      false,
    );
  });

  it("follows the toolbar for generated files once the reader expands or folds everything", () => {
    expect(fileDiffFoldDefault("pnpm-lock.yaml", "expanded", false, NO_ATTRIBUTIONS)).toBe(
      "expanded",
    );
    expect(fileDiffFoldDefault("src/app.ts", "folded", false, NO_ATTRIBUTIONS)).toBe("folded");
  });

  it("leaves a folded lockfile alone when ticked and opens it when the tick is taken off", () => {
    const foldDefault = fileDiffFoldDefault("pnpm-lock.yaml", null, false, NO_ATTRIBUTIONS);
    const toggled = toggleFileDiffFoldForViewed("pnpm-lock.yaml", false, foldDefault, NO_TOGGLES);
    expect(isFileDiffCollapsed("pnpm-lock.yaml", foldDefault, toggled)).toBe(false);
    expect(toggleFileDiffFoldForViewed("pnpm-lock.yaml", true, foldDefault, NO_TOGGLES)).toBe(
      NO_TOGGLES,
    );
  });
});
