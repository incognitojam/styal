// @effect-diagnostics nodeBuiltinImport:off - Disposable git histories exercise the scanner.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

import { scanUpstreamCommits } from "./upstream-commit-scan.ts";

function withRepository(test: (repo: ReturnType<typeof repository>) => void) {
  const repo = repository();
  try {
    test(repo);
  } finally {
    NodeFS.rmSync(repo.root, { recursive: true, force: true });
  }
}

function repository() {
  const scratch = NodePath.resolve(import.meta.dirname, "../.scratch");
  NodeFS.mkdirSync(scratch, { recursive: true });
  const root = NodeFS.mkdtempSync(NodePath.join(scratch, "upstream-commit-scan-test-"));
  const git = (args: ReadonlyArray<string>, date = "2026-09-14T00:00:00Z") =>
    NodeChildProcess.execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.test",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.test",
        },
      },
    ).trim();
  git(["init", "--initial-branch=main"]);
  git(["commit", "--allow-empty", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]);
  git(["branch", "fork", base]);
  let count = 0;
  const commit = (title: string, date?: string) => {
    count += 1;
    NodeFS.writeFileSync(NodePath.join(root, `file-${count}.txt`), title);
    git(["add", "."]);
    git(["commit", "-m", title], date);
    return git(["rev-parse", "HEAD"]);
  };
  const run = (command: string, args: ReadonlyArray<string>) =>
    command === "git" ? git(args) : "[[]]";
  const input = {
    upstreamRepository: "example/upstream",
    upstreamRef: "main",
    mainRef: "fork",
    pullRequestsByMergeSha: new Map<string, number>(),
  };
  return { root, git, commit, run, input, base };
}

describe("upstream commit coverage", () => {
  it("discovers backdated commits by position, flags empty PR merges, and does not rescan old work", () =>
    withRepository((repo) => {
      const source = repo.commit("unassociated implementation", "2020-01-01T00:00:00Z");
      repo.git(["commit", "--allow-empty", "-m", "record PR merge"]);
      const empty = repo.git(["rev-parse", "HEAD"]);
      const first = scanUpstreamCommits(
        { ...repo.input, pullRequestsByMergeSha: new Map([[empty, 123]]) },
        repo.run,
      );
      assert.deepEqual(
        first.commits.map((commit) => commit.sha),
        [source],
      );
      assert.deepEqual(first.emptyPullRequests, [123]);
      assert.strictEqual(first.from, repo.base);
      assert.strictEqual(first.head, empty);
      const later = repo.commit("later push with an even older date", "2019-01-01T00:00:00Z");
      const second = scanUpstreamCommits({ ...repo.input, previousHead: first.head }, repo.run);
      assert.deepEqual(
        second.commits.map((commit) => commit.sha),
        [later],
      );
      assert.strictEqual(second.scanned, 1);
    }));

  it("stops when upstream rewrites the saved history", () =>
    withRepository((repo) => {
      const saved = repo.commit("old history");
      repo.git(["reset", "--hard", repo.base]);
      repo.commit("rewritten history");
      assert.throws(
        () => scanUpstreamCommits({ ...repo.input, previousHead: saved }, repo.run),
        "no longer descends",
      );
    }));

  it("suppresses a rebase-merge sibling only when its merged PR is in the inventory", () =>
    withRepository((repo) => {
      const sibling = repo.commit("first PR commit");
      const merge = repo.commit("second PR commit");
      const run = (command: string, args: ReadonlyArray<string>) =>
        command === "git"
          ? repo.git(args)
          : JSON.stringify([
              [
                {
                  number: 123,
                  merged_at: "2026-09-14T00:00:00Z",
                  merge_commit_sha: merge,
                  base: { ref: "main", repo: { full_name: "example/upstream" } },
                },
              ],
            ]);
      const covered = scanUpstreamCommits(
        { ...repo.input, pullRequestsByMergeSha: new Map([[merge, 123]]) },
        run,
      );
      assert.deepEqual(covered.commits, []);
      assert.throws(() => scanUpstreamCommits(repo.input, run), "--since-days wide enough");
      const unreachable = (command: string, args: ReadonlyArray<string>) =>
        command === "git" ? repo.git(args) : run(command, args).replaceAll(merge, "f".repeat(40));
      const uncovered = scanUpstreamCommits(repo.input, unreachable);
      assert.deepEqual(
        uncovered.commits.map((commit) => commit.sha),
        [sibling, merge],
      );
    }));

  it("represents a non-PR merge once using its first-parent diff", () =>
    withRepository((repo) => {
      repo.git(["checkout", "-b", "side"]);
      const side = repo.commit("side branch change");
      repo.git(["checkout", "main"]);
      repo.git(["merge", "--no-ff", "side", "-m", "direct merge"]);
      const merge = repo.git(["rev-parse", "HEAD"]);
      const result = scanUpstreamCommits(repo.input, repo.run);
      assert.deepEqual(
        result.commits.map((commit) => commit.sha),
        [merge],
      );
      assert.notInclude(
        result.commits.map((commit) => commit.sha),
        side,
      );
      assert.deepEqual(result.commits[0]?.areas, ["file-1.txt"]);
      assert.include(result.commits[0]?.reviewReason ?? "", "first-parent diff");
    }));
});
