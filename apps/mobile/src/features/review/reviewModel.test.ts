import { describe, expect, it } from "vite-plus/test";

import { MessageId, RunId, type ReviewDiffPreviewSource } from "@t3tools/contracts";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";

import {
  applyReviewDiffMetadata,
  buildReviewParsedDiff,
  buildReviewSectionItems,
  getDefaultReviewSectionId,
  getReviewSectionIdForCheckpoint,
} from "./reviewModel";

function makeCheckpoint(
  input: Partial<ThreadCheckpointSummary> &
    Pick<ThreadCheckpointSummary, "runId" | "checkpointTurnCount" | "completedAt">,
): ThreadCheckpointSummary {
  return {
    checkpointRef: `refs/t3/checkpoints/thread/${input.checkpointTurnCount}` as any,
    status: "ready",
    files: [],
    assistantMessageId: MessageId.make(`msg-${input.checkpointTurnCount}`),
    ...input,
  };
}

describe("buildReviewSectionItems", () => {
  it("keeps one chip per checkpoint and appends git sources", () => {
    const checkpoints = [
      makeCheckpoint({
        runId: RunId.make("run-1"),
        checkpointTurnCount: 1,
        completedAt: "2026-04-01T00:00:00.000Z",
      }),
      makeCheckpoint({
        runId: RunId.make("run-2"),
        checkpointTurnCount: 2,
        completedAt: "2026-04-02T00:00:00.000Z",
      }),
    ];
    const gitSections: ReviewDiffPreviewSource[] = [
      {
        id: "working-tree",
        kind: "working-tree",
        title: "Uncommitted",
        baseRef: "HEAD",
        headRef: null,
        diff: "diff --git a/a.ts b/a.ts",
        diffHash: "hash-dirty",
        truncated: false,
      },
      {
        id: "branch-range",
        kind: "branch-range",
        title: "Changes vs main",
        baseRef: "main",
        headRef: "feature",
        diff: "diff --git a/a.ts b/a.ts",
        diffHash: "hash-base",
        truncated: false,
      },
    ];

    const loadedTurnId = getReviewSectionIdForCheckpoint(checkpoints[0]!);
    const items = buildReviewSectionItems({
      checkpoints,
      gitSections,
      turnDiffById: {
        [loadedTurnId]: {
          diff: "diff --git a/loaded.ts b/loaded.ts",
          generatedPaths: ["loaded.generated.ts"],
        },
      },
      loadingTurnIds: {
        [getReviewSectionIdForCheckpoint(checkpoints[1]!)]: true,
      },
      loadingGitSections: false,
    });

    expect(items.map((item) => item.id)).toEqual([
      "turn:2",
      "turn:1",
      "git:working-tree",
      "git:branch-range",
    ]);
    expect(items[0]).toMatchObject({ isLoading: true, diff: null });
    expect(items[1]).toMatchObject({
      isLoading: false,
      diff: expect.stringContaining("loaded.ts"),
      generatedPaths: ["loaded.generated.ts"],
    });
    expect(getDefaultReviewSectionId(items)).toBe("git:branch-range");
  });
});

describe("buildReviewParsedDiff", () => {
  it.each([
    ["a/example.ts", "a/example.ts"],
    ["b/example.ts", "b/example.ts"],
    ["a/before.ts", "b/after.ts"],
  ])("preserves repository paths from %s to %s", (previousPath, path) => {
    const parsed = buildReviewParsedDiff(
      [
        `diff --git a/${previousPath} b/${path}`,
        ...(previousPath === path
          ? []
          : ["similarity index 50%", `rename from ${previousPath}`, `rename to ${path}`]),
        `--- a/${previousPath}`,
        `+++ b/${path}`,
        "@@ -1 +1 @@",
        "-before",
        "+after",
      ].join("\n"),
      "repository-paths",
    );
    expect(parsed.kind).toBe("files");
    if (parsed.kind !== "files") return;
    expect(parsed.files[0]).toMatchObject({
      path,
      previousPath: previousPath === path ? null : previousPath,
      additions: 1,
      deletions: 1,
    });
  });

  it("builds renderable rows from a unified patch", () => {
    const parsed = buildReviewParsedDiff(
      [
        "diff --git a/apps/mobile/src/a.ts b/apps/mobile/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/apps/mobile/src/a.ts",
        "+++ b/apps/mobile/src/a.ts",
        "@@ -1,2 +1,3 @@",
        "-const before = 1;",
        "+const after = 2;",
        "+console.log(after);",
        " return true;",
      ].join("\n"),
      "unit",
    );

    expect(parsed.kind).toBe("files");
    if (parsed.kind !== "files") {
      return;
    }

    expect(parsed.fileCount).toBe(1);
    expect(parsed.additions).toBe(2);
    expect(parsed.deletions).toBe(1);
    expect(parsed.files[0]).toMatchObject({
      path: "apps/mobile/src/a.ts",
      additions: 2,
      deletions: 1,
    });
    expect(parsed.files[0]?.rows).toEqual([
      expect.objectContaining({ kind: "hunk", header: "@@ -1,2 +1,3 @@" }),
      expect.objectContaining({
        kind: "line",
        change: "delete",
        oldLineNumber: 1,
        newLineNumber: null,
        content: "const before = 1;",
        comparison: { change: "add", tokenIndex: 0 },
      }),
      expect.objectContaining({
        kind: "line",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 1,
        content: "const after = 2;",
        comparison: { change: "delete", tokenIndex: 0 },
      }),
      expect.objectContaining({
        kind: "line",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 2,
        content: "console.log(after);",
        comparison: null,
      }),
      expect.objectContaining({
        kind: "line",
        change: "context",
        oldLineNumber: 2,
        newLineNumber: 3,
        content: "return true;",
        comparison: null,
      }),
    ]);
  });

  it("treats truncated patches as partial diffs instead of failing", () => {
    const parsed = buildReviewParsedDiff(
      [
        "diff --git a/apps/mobile/src/a.ts b/apps/mobile/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/apps/mobile/src/a.ts",
        "+++ b/apps/mobile/src/a.ts",
        "@@ -1 +1,2 @@",
        " const before = 1;",
        "+const after = 2;",
        "",
        "[truncated]",
      ].join("\n"),
      "unit-truncated",
    );

    expect(parsed.kind).toBe("files");
    if (parsed.kind !== "files") {
      return;
    }

    expect(parsed.notice).toContain("server size cap");
    expect(parsed.fileCount).toBe(1);
    expect(parsed.files[0]?.rows[0]).toMatchObject({
      kind: "hunk",
      header: "@@ -1,1 +1,2 @@",
    });
  });
});

describe("applyReviewDiffMetadata", () => {
  it("uses complete counts even when the preview contains only part of one file", () => {
    const parsed = buildReviewParsedDiff(
      [
        "diff --git a/large.txt b/large.txt",
        "--- a/large.txt",
        "+++ b/large.txt",
        "@@ -1 +1 @@",
        "-before",
        "+after",
      ].join("\n"),
      "partial",
    );
    const result = applyReviewDiffMetadata(parsed, {
      truncated: true,
      files: [
        { path: "large.txt", previousPath: null, additions: 4000, deletions: 3000 },
        { path: "unseen.txt", previousPath: null, additions: 100, deletions: 20 },
      ],
    });
    expect(result.kind).toBe("files");
    if (result.kind !== "files") return;
    expect(result.fileCount).toBe(2);
    expect(result.additions).toBe(4100);
    expect(result.deletions).toBe(3020);
    expect(result.files[0]?.additions).toBe(4000);
    expect(result.notice).toContain("Counts include all changes");
    expect(applyReviewDiffMetadata(parsed, null)).toEqual(parsed);
  });
});
