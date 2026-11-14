import type { WorktreeCleanupPreview, WorktreeCleanupPreviewEntry } from "@t3tools/contracts";
import { ProjectId, RepositoryIdentity } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { projectFileApprovalKey } from "@t3tools/shared/projectFileApprovals";
import { describe, expect, it } from "vite-plus/test";

import {
  worktreeCleanupApprovalsFor,
  worktreeCleanupMatchesByPattern,
  worktreeCleanupPatternList,
  worktreeCleanupPatternShape,
  worktreeCleanupPreviewComplete,
  worktreeCleanupResults,
  worktreeCleanupWorkFolders,
} from "./worktreeCleanup.ts";

const decodeRepositoryIdentity = Schema.decodeUnknownSync(RepositoryIdentity);
const at = (day: number) => `2026-11-${String(day).padStart(2, "0")}T00:00:00.000Z`;

describe("worktreeCleanupApprovalsFor", () => {
  it("reads a project's approvals by its id, not by its repository", () => {
    const project = {
      id: ProjectId.make("project-a"),
      workspaceRoot: "/work/widgets",
      repositoryIdentity: decodeRepositoryIdentity({
        canonicalKey: "github.com/acme/widgets",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "git@github.com:acme/widgets.git",
        },
        rootPath: "/work/widgets",
      }),
    };
    const repositoryKey = projectFileApprovalKey(project);
    expect(repositoryKey).not.toBe(project.id);
    const settings = {
      worktreeCleanupApprovals: {
        [project.id]: { dist: { approvedAt: at(1) } },
        [repositoryKey]: { ".cache": { approvedAt: at(1) } },
      },
    };
    expect(
      worktreeCleanupPatternList(
        ["dist", ".cache"],
        worktreeCleanupApprovalsFor(settings, project),
      ),
    ).toEqual({ pending: [".cache"], approved: ["dist"], earlier: [] });
  });
});

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

  it("counts an approved path inside a pending one, and a nested path only once", () => {
    const nested = preview([
      entry({
        selected: [
          selected("dist", "dist", 1024, "pending"),
          { ...selected("dist/sub", "dist/sub", 512), insideSelected: "dist" },
        ],
      }),
    ]);
    expect(worktreeCleanupResults(nested, new Set(["dist/sub"])).totalBytes).toBe(512);
    expect(worktreeCleanupResults(nested, new Set(["dist", "dist/sub"])).totalBytes).toBe(1024);
    const matches = worktreeCleanupMatchesByPattern(nested);
    expect(matches.get("dist")?.bytes).toBe(1024);
    expect(matches.get("dist/sub")?.bytes).toBe(512);
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

describe("unknown results stay unknown", () => {
  it("reports a walk that stopped early as not fully checked, never as nothing matched", () => {
    const stopped = preview([
      entry({ entriesTruncated: true, measurementComplete: false, freedBytes: null }),
    ]);
    expect(worktreeCleanupResults(stopped, new Set(["**/node_modules"])).notCleaned).toEqual([
      expect.objectContaining({ reason: "not-fully-checked", incomplete: true }),
    ]);
    expect(worktreeCleanupPreviewComplete(stopped)).toBe(false);
  });

  it("marks a measured path next to an over-limit candidate as a lower bound", () => {
    const results = worktreeCleanupResults(
      preview([
        entry({
          measurementComplete: false,
          selected: [selected("dist", "dist", 100)],
          kept: [{ path: "node_modules", pattern: "nm", reason: "too-large-to-verify" }],
        }),
      ]),
      new Set(["dist", "nm"]),
    );
    expect(results.cleaned.map((row) => [row.freedBytes, row.incomplete])).toEqual([[100, true]]);
    expect(results.incomplete).toBe(true);
  });

  it("marks every pattern total incomplete when part of the preview was not checked", () => {
    const matches = worktreeCleanupMatchesByPattern(
      preview([
        entry({ worktreePath: "/w/a", selected: [selected("dist", "dist", 10)] }),
        entry({ worktreePath: "/w/b", entriesTruncated: true, measurementComplete: false }),
      ]),
    );
    expect(matches.get("dist")?.incomplete).toBe(true);
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
