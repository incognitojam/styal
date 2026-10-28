import { assert, describe, it } from "@effect/vitest";

import { laterFixesByBatchCommit } from "./later-fixes.ts";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const later = (
  commitSha: string,
  pr: number | null,
  text: string,
  title = text.split("\n", 1)[0]!,
) => ({ sha: commitSha, pr, title, text });
const batch = [
  { sha: `abcdef1${"0".repeat(33)}`, pr: 100 },
  { sha: sha(2), pr: 200 },
];
const find = (commits: ReadonlyArray<ReturnType<typeof later>>) =>
  laterFixesByBatchCommit(batch, commits, "pingdotgg/t3code");

describe("laterFixesByBatchCommit", () => {
  it("flags a later fix whose description names a batch PR, quoting the sentence", () => {
    const fixes = find([
      later(
        sha(9),
        900,
        [
          "fix(server): Stop stops a thread's subagents again (#900)",
          "",
          "## Problem",
          "",
          "Pressing Stop should stop children. Since [#200](https://github.com/pingdotgg/t3code/pull/200), the Stop button sends `thread.stop`. That path never stops them.",
        ].join("\n"),
      ),
    ]);
    assert.deepStrictEqual(fixes.get(sha(2)), [
      {
        sha: sha(9),
        pr: 900,
        title: "fix(server): Stop stops a thread's subagents again (#900)",
        evidence: "Since #200, the Stop button sends `thread.stop`.",
      },
    ]);
    assert.isUndefined(fixes.get(batch[0]!.sha));
  });

  it("flags reverts by title reference or commit SHA", () => {
    const fixes = find([
      later(sha(7), 700, "revert: one (#100) (#700)"),
      later(sha(8), null, 'Revert "one"\n\nThis reverts commit abcdef1000.'),
    ]);
    assert.deepStrictEqual(
      fixes.get(batch[0]!.sha)?.map((fix) => [fix.sha, fix.evidence]),
      [
        [sha(7), "revert: one (#100) (#700)"],
        [sha(8), "This reverts commit abcdef1000."],
      ],
    );
  });

  it("classifies a merge commit by its PR title", () => {
    const fixes = find([
      later(
        sha(6),
        600,
        "Merge pull request #600 from someone/branch\n\nRepair the regression\nRegressed in #100.",
        "fix: repair the regression",
      ),
    ]);
    assert.deepStrictEqual(
      fixes.get(batch[0]!.sha)?.map((fix) => [fix.title, fix.evidence]),
      [["fix: repair the regression", "Regressed in #100."]],
    );
  });

  it("ignores non-fix commits, other repositories' references, and code examples", () => {
    const fixes = find([
      later(sha(5), 500, "test(web): prune tests\n\nDrops cases from #100."),
      later(
        sha(6),
        600,
        [
          "fix(server): worktrees on Windows",
          "",
          "Git fixed it in git-for-windows/git#100, other/t3code#200 and https://github.com/other/t3code/pull/200.",
          "Fixed by [#100](https://github.com/other/repo/pull/100).",
          "Tested against main abcdef1000.",
          "```",
          "see #100",
          "```",
        ].join("\n"),
      ),
    ]);
    assert.strictEqual(fixes.size, 0);
  });

  it("reads upstream links in either the GitHub or mirror form", () => {
    const fixes = find([
      later(
        sha(4),
        400,
        "fix: settings load\n\nSince https://git.cafe/pingdotgg/t3code/pulls/100 older clients fail. Also pingdotgg/t3code#200 broke it.",
      ),
    ]);
    assert.deepStrictEqual(
      [...fixes].map(([target, found]) => [target, found[0]!.evidence]),
      [
        [batch[0]!.sha, "Since https://git.cafe/pingdotgg/t3code/pulls/100 older clients fail."],
        [sha(2), "Also pingdotgg/t3code#200 broke it."],
      ],
    );
  });

  it("quotes the sentence holding the reference, not an earlier one with a longer number", () => {
    const fixes = find([later(sha(3), 300, "fix: x\n\nUnrelated to #1000. Regressed in #100.")]);
    assert.strictEqual(fixes.get(batch[0]!.sha)?.[0]?.evidence, "Regressed in #100.");
  });
});
