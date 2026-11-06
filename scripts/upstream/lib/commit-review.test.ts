// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { parse } from "yaml";

import {
  adaptationErrors,
  cherryPickSources,
  changedLinesByFile,
  type CommitReview,
  compareWithUpstream,
  forkAdaptationNote,
  preservedFeatureIds,
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

  it("reads the ledger features named in Fork-Feature trailers", () => {
    assert.deepEqual(
      preservedFeatureIds(
        `${message}Fork-Feature: completion-sounds, github-reference-links\nfork-feature: completion-sounds\n`,
      ),
      ["completion-sounds", "github-reference-links"],
    );
    assert.deepEqual(preservedFeatureIds(message), []);
  });
});

describe("compareWithUpstream", () => {
  it("matches a cherry-pick onto moved code", () => {
    const upstream = patch("src/a.ts", ["@@ -10 +10 @@", "-old", "+new"]);
    const fork = patch("src/a.ts", ["@@ -42 +42 @@", "-old", "+new"]);
    assert.deepEqual(compareWithUpstream({ upstreamPatches: [upstream], forkPatch: fork }), []);
  });

  it("distinguishes modes, binary content, order and context", () => {
    for (const [upstream, fork] of [
      [
        "index aaa..bbb\nGIT binary patch\ndelta 4\ncopy",
        "index ccc..ddd\nGIT binary patch\ndelta 4\ncopy",
      ],
      ["index 111..222 100644\n+x", "index 111..222 100755\n+x"],
      ["old mode 100644\nnew mode 100755", "old mode 100644\nnew mode 100644"],
      ["GIT binary patch\nliteral 1\nA", "GIT binary patch\nliteral 1\nB"],
      ["@@ -1,2 +1,2 @@\n+a\n+b", "@@ -1,2 +1,2 @@\n+b\n+a"],
      ["@@ -1 +1 @@\n context-a\n+x", "@@ -1 +1 @@\n context-b\n+x"],
    ]) {
      assert.isNotEmpty(
        compareWithUpstream({
          upstreamPatches: [patch("file", [upstream!])],
          forkPatch: patch("file", [fork!]),
        }),
      );
    }
  });

  it("keeps ambiguous spaces and Git quoted paths intact", () => {
    const spaced = "apps/web/src/a b/fixture.ts";
    assert.deepEqual([...changedLinesByFile([patch(spaced, ["+x"])]).keys()], [spaced]);
    const quoted = 'diff --git "a/a\\tfile" "b/a\\tfile"\n+x';
    assert.deepEqual([...changedLinesByFile([quoted]).keys()], ["a\tfile"]);
    assert.deepEqual(compareWithUpstream({ upstreamPatches: [quoted], forkPatch: quoted }), []);
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
        upstreamLines: [
          "index 100644",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -,2 +,2 @@",
          "-one",
          "-two",
          "+uno",
          "+dos",
        ],
        forkLines: [
          "index 100644",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -,2 +,2 @@",
          "-one",
          "-two",
          "+uno",
          "+zwei",
        ],
      },
      {
        path: "src/fork.ts",
        upstreamLines: [],
        forkLines: [
          "index 100644",
          "--- a/src/fork.ts",
          "+++ b/src/fork.ts",
          "@@ -,0 + @@",
          "+fork only",
        ],
      },
    ]);
  });
});

const base: CommitReview = {
  sha: "b".repeat(40),
  subject: "fix(web): keep rows prominent (#1234)",
  pullRequestNumbers: [1234],
  sourceCommits: [sourceSha],
  listedCommits: [],
  adaptationNote: null,
  preservedFeatureIds: [],
  comparison: { status: "matches" },
  featureIds: [],
};

const adapted: CommitReview["comparison"] = {
  status: "adapted",
  files: [{ path: "src/a.ts", upstreamLines: ["+dos"], forkLines: ["+zwei"] }],
};

describe("adaptationErrors", () => {
  const known = new Set(["completion-sounds"]);

  it("accepts an explained difference that cites a ledger feature", () => {
    assert.deepEqual(
      adaptationErrors(
        {
          ...base,
          comparison: adapted,
          adaptationNote: "Keep per-event sounds.",
          preservedFeatureIds: ["completion-sounds"],
        },
        known,
      ),
      [],
    );
  });

  it("requires a note on a commit that differs from upstream", () => {
    assert.deepEqual(adaptationErrors({ ...base, comparison: adapted }, known), [
      "Candidate commit bbbbbbbbbbbb differs from upstream but has no `Fork adaptation:` note explaining why.",
    ]);
  });

  it("rejects a cited feature on a commit that matches upstream", () => {
    assert.deepEqual(
      adaptationErrors({ ...base, preservedFeatureIds: ["completion-sounds"] }, known),
      [
        "Candidate commit bbbbbbbbbbbb matches upstream but cites Fork-Feature completion-sounds; remove the trailer.",
      ],
    );
  });

  it("rejects a feature the ledger does not list", () => {
    assert.deepEqual(
      adaptationErrors(
        {
          ...base,
          comparison: adapted,
          adaptationNote: "Keep project headers.",
          preservedFeatureIds: ["sidebar-project-groups"],
        },
        known,
      ),
      [
        "Candidate commit bbbbbbbbbbbb cites Fork-Feature sidebar-project-groups, which is not in the fork feature ledger.",
      ],
    );
  });

  it("allows a note without a feature on a commit that matches upstream", () => {
    assert.deepEqual(
      adaptationErrors({ ...base, adaptationNote: "Adopt upstream's composer drafts." }, known),
      [],
    );
  });
});

describe("renderCommitReviews", () => {
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
    assert.include(
      summary,
      "<details><summary>2 commits match upstream or change no files</summary>",
    );
    // The PR link covers the commit cherry-picked from it.
    assert.notInclude(summary, "/commit/aaaaaaaaaa");
  });

  it("puts commits that differ first and collapses the ones that match", () => {
    const summary = renderCommitReviews({
      upstreamRepository: "example/upstream",
      reviews: [
        { ...base, subject: "fix: matches" },
        {
          ...base,
          subject: "fix: not compared",
          comparison: { status: "unavailable", reason: "the source is missing." },
        },
        { ...base, subject: "fix: adapted", comparison: adapted },
      ],
    });

    const notCompared = summary.indexOf("### 2. fix: not compared");
    const adaptedSection = summary.indexOf("### 3. fix: adapted");
    const collapsed = summary.indexOf("<details><summary>1 commit matches upstream</summary>");
    const matches = summary.indexOf("### 1. fix: matches");
    assert.isAbove(notCompared, -1);
    assert.isAbove(adaptedSection, notCompared);
    assert.isAbove(collapsed, adaptedSection);
    assert.isAbove(matches, collapsed);
  });

  it("shows how an adapted commit differs, with the command for the full comparison", () => {
    const summary = renderCommitReviews({
      upstreamRepository: "example/upstream",
      reviews: [
        {
          ...base,
          listedCommits: ["d".repeat(40)],
          adaptationNote: "Approval rows stay prominent.",
          preservedFeatureIds: ["sidebar-attention-prominence"],
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
    assert.include(summary, "Preserves: `sidebar-attention-prominence`");
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

describe("intake fixture histories", () => {
  it("accounts for binary, mode, reordered, renamed and earlier-push changes", () => {
    const root = NodePath.resolve(import.meta.dirname, "../../../.scratch");
    NodeFS.mkdirSync(root, { recursive: true });
    const cwd = NodeFS.mkdtempSync(NodePath.join(root, "intake-holes-history-"));
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    const commit = () => {
      git("add", "-A");
      git(
        "-c",
        "user.name=Synthetic",
        "-c",
        "user.email=synthetic@example.invalid",
        "commit",
        "-qm",
        "fixture",
      );
      return git("rev-parse", "HEAD");
    };
    const diff = (base: string, head: string) =>
      git("diff", "--binary", "--full-index", "--no-renames", "-U3", base, head);
    try {
      git("init", "-q");
      NodeFS.mkdirSync(NodePath.join(cwd, "apps/mobile"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(cwd, "apps/mobile/Test.swift"), "a\nb\n");
      NodeFS.writeFileSync(NodePath.join(cwd, "binary"), Buffer.from([0, 1]));
      const base = commit();
      NodeFS.chmodSync(NodePath.join(cwd, "apps/mobile/Test.swift"), 0o755);
      const mode = commit();
      NodeFS.writeFileSync(NodePath.join(cwd, "binary"), Buffer.from([0, 2]));
      const binary = commit();
      NodeFS.writeFileSync(NodePath.join(cwd, "apps/mobile/Test.swift"), "b\na\n");
      const reordered = commit();
      git("mv", "apps/mobile/Test.swift", "relocated.swift");
      const rename = commit();
      NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "last push");
      const head = commit();
      for (const [before, after] of [
        [base, mode],
        [mode, binary],
        [binary, reordered],
        [reordered, rename],
      ]) {
        assert.isNotEmpty(
          compareWithUpstream({ upstreamPatches: [], forkPatch: diff(before!, after!) }),
        );
      }
      const paths = git("diff", "--name-only", "--no-renames", base, head).split("\n");
      assert.includeMembers(paths, [
        "apps/mobile/Test.swift",
        "relocated.swift",
        "binary",
        "README.md",
      ]);
      assert.equal(git("diff", "--name-only", rename, head), "README.md");
      const workflow = parse(
        NodeFS.readFileSync(
          NodePath.resolve(import.meta.dirname, "../../../.github/workflows/fork-macos.yml"),
          "utf8",
        ),
      );
      const detector = workflow.jobs.changes.steps.find(
        (step: { id?: string }) => step.id === "detect",
      ).run;
      const bin = NodePath.join(cwd, "bin");
      NodeFS.mkdirSync(bin);
      NodeFS.writeFileSync(
        NodePath.join(bin, "gh"),
        [
          "#!/bin/bash",
          'case "$2" in',
          `*/git/ref/heads/main) echo '${base}' ;;`,
          `*/compare/${base}...*) git diff --name-only --no-renames ${base} ${head} ;;`,
          "*/compare/*) echo README.md ;;",
          "*) exit 1 ;;",
          "esac",
        ].join("\n"),
        { mode: 0o755 },
      );
      const output = NodePath.join(cwd, "outputs");
      NodeChildProcess.execFileSync("bash", ["-c", detector], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: "synthetic/fork",
          GITHUB_REF: "refs/heads/intake/fixture",
          PR_NUMBER: "",
          BEFORE_SHA: rename,
          GITHUB_SHA: head,
        },
      });
      assert.include(NodeFS.readFileSync(output, "utf8"), "mobile_native=true");
    } finally {
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
