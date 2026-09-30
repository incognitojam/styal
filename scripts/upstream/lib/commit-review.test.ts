import { assert, describe, it } from "@effect/vitest";

import {
  cherryPickSources,
  type CommitReview,
  compareWithUpstream,
  forkAdaptationNote,
  renderCommitReviews,
} from "./commit-review.ts";

function patch(path: string, hunks: ReadonlyArray<string>): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunks,
  ].join("\n");
}

const sourceSha = "a".repeat(40);
const message = `fix(web): keep rows prominent (#1234)

Co-authored-by: Example <example@example.com>

Fork adaptation: Approval rows stay prominent,
and the ledger entry narrows.

(cherry picked from commit ${sourceSha})
Upstream-PR: 1234
`;

describe("commit review sources", () => {
  it("reads the cherry-picked source and the adaptation note", () => {
    assert.deepEqual(cherryPickSources(message), [sourceSha]);
    assert.equal(
      forkAdaptationNote(message),
      "Approval rows stay prominent, and the ledger entry narrows.",
    );
    assert.isNull(forkAdaptationNote("fix: plain import\n\nUpstream-PR: 1"));
  });
});

describe("compareWithUpstream", () => {
  it("matches a cherry-pick onto moved code", () => {
    const upstream = patch("src/a.ts", ["@@ -10 +10 @@", "-old", "+new"]);
    const fork = patch("src/a.ts", ["@@ -42 +42 @@", "-old", "+new"]);
    assert.deepEqual(compareWithUpstream({ upstreamPatches: [upstream], forkPatch: fork }), []);
  });

  it("combines several upstream sources", () => {
    const first = patch("src/a.ts", ["@@ -1 +1 @@", "-a", "+b"]);
    const second = patch("src/b.ts", ["@@ -1 +1 @@", "-c", "+d"]);
    const fork = [first, second].join("\n");
    assert.deepEqual(
      compareWithUpstream({ upstreamPatches: [first, second], forkPatch: fork }),
      [],
    );
  });

  it("reports each file whose changed lines differ, keeping patch order", () => {
    const upstream = patch("src/a.ts", ["@@ -1,2 +1,2 @@", "-one", "-two", "+uno", "+dos"]);
    const fork = [
      patch("src/a.ts", ["@@ -1,2 +1,2 @@", "-one", "-two", "+uno", "+zwei"]),
      patch("src/fork.ts", ["@@ -0,0 +1 @@", "+fork only"]),
    ].join("\n");
    assert.deepEqual(compareWithUpstream({ upstreamPatches: [upstream], forkPatch: fork }), [
      {
        path: "src/a.ts",
        upstreamLines: ["-one", "-two", "+uno", "+dos"],
        forkLines: ["-one", "-two", "+uno", "+zwei"],
      },
      { path: "src/fork.ts", upstreamLines: [], forkLines: ["+fork only"] },
    ]);
  });
});

describe("renderCommitReviews", () => {
  const base: CommitReview = {
    sha: "b".repeat(40),
    subject: "fix(web): keep rows prominent (#1234)",
    pullRequestNumbers: [1234],
    sourceCommits: [sourceSha],
    listedCommits: [],
    adaptationNote: null,
    comparison: { status: "matches" },
    featureIds: [],
  };

  it("lists each commit with its upstream PR and whether it matches", () => {
    const summary = renderCommitReviews({
      upstreamRepository: "example/upstream",
      reviews: [
        base,
        {
          ...base,
          sha: "c".repeat(40),
          subject: "fix(mobile): already present (#99)",
          pullRequestNumbers: [99],
          adaptationNote: "Already present.",
          comparison: { status: "provenance-only" },
          featureIds: ["watched-capability"],
        },
      ],
    });

    assert.include(summary, "0 of 2 commits differ from their upstream sources.");
    assert.include(summary, "### 1. fix(web): keep rows prominent (#1234)");
    assert.include(
      summary,
      "`bbbbbbbbbb` from [example/upstream#1234](https://github.com/example/upstream/pull/1234). Matches upstream.",
    );
    assert.include(summary, "Changes no files; records provenance only.");
    assert.include(summary, "> Already present.");
    assert.include(summary, "Fork features: `watched-capability`");
    // The PR link covers the commit cherry-picked from it.
    assert.notInclude(summary, "/commit/aaaaaaaaaa");
  });

  it("shows how an adapted commit differs, with the command for the full comparison", () => {
    const summary = renderCommitReviews({
      upstreamRepository: "example/upstream",
      reviews: [
        {
          ...base,
          listedCommits: ["d".repeat(40)],
          adaptationNote: "Approval rows stay prominent.",
          comparison: {
            status: "adapted",
            files: [
              {
                path: "src/a.ts",
                upstreamLines: ["+dos"],
                forkLines: ["+zwei"],
                interdiff: ["-+dos", "++zwei"],
              },
            ],
          },
        },
      ],
    });

    assert.include(summary, "1 of 1 commits differ from their upstream sources.");
    assert.include(summary, "Differs from upstream in 1 file.");
    assert.include(summary, "commit [`dddddddddd`]");
    assert.include(summary, "```diff\n# src/a.ts\n-+dos\n++zwei\n```");
    assert.include(summary, "git range-diff aaaaaaaaaaaa^! bbbbbbbbbbbb^!");
  });

  it("caps the lines shown and keeps a fence longer than any backtick run", () => {
    const summary = renderCommitReviews({
      upstreamRepository: "example/upstream",
      reviews: [
        {
          ...base,
          comparison: {
            status: "adapted",
            files: [
              {
                path: "src/a.ts",
                upstreamLines: [],
                forkLines: [],
                interdiff: Array.from({ length: 100 }, (_, index) => `++line ${index} \`\`\``),
              },
            ],
          },
        },
      ],
    });

    assert.include(summary, "… 21 more lines");
    assert.include(summary, "````diff");
  });
});
