import type { WorktreeCleanupPreview, WorktreeCleanupPreviewEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  worktreeCleanupMatchesByPattern,
  worktreeCleanupPatternList,
  worktreeCleanupPatternShape,
  worktreeCleanupResults,
  worktreeCleanupWorkFolders,
} from "./worktreeCleanup.ts";

const at = (day: number) => `2026-11-${String(day).padStart(2, "0")}T00:00:00.000Z`;

describe("worktreeCleanupPatternList", () => {
  it("lists pending patterns, then approved ones, each in styal.json order", () => {
    expect(
      worktreeCleanupPatternList(["dist", "**/node_modules", ".cache", "target"], {
        target: { approvedAt: at(1) },
        dist: { approvedAt: at(2) },
      }),
    ).toEqual({
      pending: ["**/node_modules", ".cache"],
      approved: ["dist", "target"],
      earlier: [],
    });
  });

  it("ignores duplicates and surrounding spaces", () => {
    expect(
      worktreeCleanupPatternList([" dist", "dist", "dist "], { dist: { approvedAt: at(1) } }),
    ).toEqual({ pending: [], approved: ["dist"], earlier: [] });
  });

  it("never treats inherited object properties as approvals", () => {
    expect(worktreeCleanupPatternList(["constructor", "toString", "__proto__"], {})).toEqual({
      pending: ["constructor", "toString", "__proto__"],
      approved: [],
      earlier: [],
    });
  });

  it("keeps patterns no longer declared, newest approval first", () => {
    expect(
      worktreeCleanupPatternList(["dist"], {
        dist: { approvedAt: at(1) },
        build: { approvedAt: at(3) },
        "apps/*/out": { approvedAt: at(5) },
      }).earlier,
    ).toEqual([
      { pattern: "apps/*/out", approvedAt: at(5) },
      { pattern: "build", approvedAt: at(3) },
    ]);
  });
});

describe("worktreeCleanupWorkFolders", () => {
  it("names work folders a pattern deletes from, by pattern or by what a preview found", () => {
    expect(worktreeCleanupWorkFolders(".scratch")).toEqual([".scratch"]);
    expect(worktreeCleanupWorkFolders(".plans/drafts")).toEqual([".plans"]);
    expect(worktreeCleanupWorkFolders("**/node_modules")).toEqual([]);
    expect(worktreeCleanupWorkFolders("**/notes", [".scratch/notes", "apps/notes"])).toEqual([
      ".scratch",
    ]);
  });
});

describe("worktreeCleanupPatternShape", () => {
  it("guesses files from an extension wildcard and folders otherwise", () => {
    expect(worktreeCleanupPatternShape("**/*.tsbuildinfo")).toBe("file");
    expect(worktreeCleanupPatternShape("**/node_modules")).toBe("directory");
    expect(worktreeCleanupPatternShape("target")).toBe("directory");
  });
});

const entry = (overrides: Partial<WorktreeCleanupPreviewEntry>): WorktreeCleanupPreviewEntry => ({
  worktreePath: "/w/a",
  threadCount: 1,
  status: "eligible",
  selected: [],
  kept: [],
  freedBytes: 0,
  entriesTruncated: false,
  measurementComplete: true,
  ...overrides,
});
const preview = (worktrees: WorktreeCleanupPreviewEntry[]): WorktreeCleanupPreview => ({
  review: { status: "approved", declared: [], approvedNotDeclared: [] },
  patterns: [],
  worktrees,
  worktreesTruncated: false,
  deadlineReached: false,
});
const selected = (
  path: string,
  pattern: string,
  freedBytes: number | null,
  patternStatus: "approved" | "pending" = "approved",
  patterns: string[] = [pattern],
) => ({
  path,
  pattern,
  patterns,
  insideSelected: null,
  patternStatus,
  kind: "directory" as const,
  freedBytes,
});

describe("worktreeCleanupResults", () => {
  it("counts only currently approved patterns and sorts cleaned worktrees by bytes freed", () => {
    const results = worktreeCleanupResults(
      preview([
        entry({ worktreePath: "/w/small", selected: [selected("dist", "dist", 10)] }),
        entry({
          worktreePath: "/w/large",
          selected: [selected("dist", "dist", 50), selected(".cache", ".cache", 900)],
        }),
        entry({ worktreePath: "/w/shared", selected: [selected("node_modules", "nm", 0)] }),
        entry({ worktreePath: "/w/none", selected: [selected(".cache", ".cache", 5, "pending")] }),
        entry({ worktreePath: "/w/busy", status: "kept", reason: "unsettled-thread" }),
      ]),
      new Set(["dist", "nm"]),
    );
    expect(results.cleaned.map((row) => [row.entry.worktreePath, row.freedBytes])).toEqual([
      ["/w/large", 50],
      ["/w/small", 10],
    ]);
    expect(results.totalBytes).toBe(60);
    expect(results.notCleaned.map((row) => [row.entry.worktreePath, row.reason])).toEqual([
      ["/w/shared", "frees-nothing"],
      ["/w/none", "nothing-matched"],
      ["/w/busy", "not-settled"],
    ]);
  });

  it("counts a path matched by a pending and an approved pattern as covered", () => {
    const results = worktreeCleanupResults(
      preview([
        entry({
          selected: [
            selected("info-only", "**/info-only", 512, "pending", ["**/info-only", "info-only"]),
          ],
        }),
      ]),
      new Set(["info-only"]),
    );
    expect(results.cleaned.map((row) => row.freedBytes)).toEqual([512]);
    expect(results.totalBytes).toBe(512);
  });

  it("keeps unmeasured and cut-short results as lower bounds", () => {
    const results = worktreeCleanupResults(
      preview([
        entry({
          worktreePath: "/w/cut",
          entriesTruncated: true,
          selected: [selected("a", "dist", 500)],
        }),
        entry({ worktreePath: "/w/unmeasured", selected: [selected("dist", "dist", null)] }),
        entry({
          worktreePath: "/w/huge",
          kept: [{ path: "node_modules", pattern: "nm", reason: "too-large-to-verify" }],
        }),
      ]),
      new Set(["dist", "nm"]),
    );
    expect(results.cleaned.map((row) => [row.entry.worktreePath, row.incomplete])).toEqual([
      ["/w/cut", true],
      ["/w/unmeasured", true],
    ]);
    expect(results.incomplete).toBe(true);
    expect(results.notCleaned.map((row) => row.reason)).toEqual(["too-large"]);
  });
});

describe("worktreeCleanupMatchesByPattern", () => {
  it("totals what each pattern matches in worktrees that could be cleaned", () => {
    const matches = worktreeCleanupMatchesByPattern(
      preview([
        entry({
          worktreePath: "/w/a",
          selected: [
            selected("node_modules", "**/node_modules", 7),
            selected("apps/web/node_modules", "**/node_modules", 3),
          ],
        }),
        entry({ worktreePath: "/w/b", selected: [selected("node_modules", "**/node_modules", 5)] }),
        entry({
          worktreePath: "/w/c",
          status: "kept",
          reason: "unsettled-thread",
          selected: [selected("node_modules", "**/node_modules", 100)],
        }),
      ]),
    );
    expect(matches.get("**/node_modules")).toEqual({
      kind: "directory",
      count: 3,
      worktrees: 2,
      bytes: 15,
      incomplete: false,
    });
    expect(matches.has("dist")).toBe(false);
  });

  it("counts a path towards every pattern that matches it", () => {
    const matches = worktreeCleanupMatchesByPattern(
      preview([
        entry({
          selected: [
            selected("info-only", "info-only", 512, "approved", ["**/info-only", "info-only"]),
          ],
        }),
      ]),
    );
    expect(matches.get("**/info-only")?.bytes).toBe(512);
    expect(matches.get("info-only")?.bytes).toBe(512);
  });
});
