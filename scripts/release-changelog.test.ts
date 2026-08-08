// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const helperPath = NodePath.resolve(repoRoot, ".github/scripts/release-changelog.sh");

function isCiReleaseCommit(subject: string, scriptPath = helperPath): boolean {
  const result = NodeChildProcess.spawnSync(
    "bash",
    [
      "-c",
      'source "$1" || exit 2; is_ci_release_commit "$2"',
      "release-changelog-test",
      scriptPath,
      subject,
    ],
    { cwd: repoRoot },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`Release changelog helper failed: ${result.stderr.toString()}`);
  }

  return result.status === 0;
}

function runGit(cwd: string, ...args: ReadonlyArray<string>): string {
  const result = NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function commitFile(cwd: string, fileName: string, contents: string, subject: string): string {
  NodeFs.writeFileSync(NodePath.join(cwd, fileName), contents);
  runGit(cwd, "add", fileName);
  runGit(cwd, "commit", "-m", subject);
  return runGit(cwd, "rev-parse", "HEAD");
}

function listForkReleaseCommits(
  cwd: string,
  previousReleaseRef: string,
  forkSourceRef: string,
  upstreamRef: string,
): ReadonlyArray<string> {
  const result = NodeChildProcess.spawnSync(
    "bash",
    [
      "-c",
      'source "$1" || exit 2; list_fork_release_commits "$2" "$3" "$4"',
      "release-changelog-test",
      helperPath,
      previousReleaseRef,
      forkSourceRef,
      upstreamRef,
    ],
    { cwd, encoding: "utf8" },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Listing fork release commits failed: ${result.stderr}`);
  }
  return result.stdout.trim() === "" ? [] : result.stdout.trim().split("\n");
}

it("surfaces release changelog helper failures", () => {
  assert.throws(
    () => isCiReleaseCommit("fix(web): display CI status", `${helperPath}.missing`),
    /Release changelog helper failed/,
  );
});

it("omits CI-only commits from release changelogs", () => {
  for (const subject of [
    "ci: move jobs to another runner",
    "ci(actions): update workflow dependencies",
    "ci(actions)!: replace the release workflow",
    "CI: replace the release workflow",
    "fix(ci): publish the populated nightly draft",
    "fix(ci)!: change release permissions",
    "fix(release, ci): publish the populated nightly draft",
    "chore(ci-cd): update release credentials",
    'Revert "ci: move jobs to another runner"',
    'Revert "fix(ci): publish the populated nightly draft" (#42)',
  ]) {
    assert.equal(isCiReleaseCommit(subject), true, subject);
  }
});

it("keeps non-CI commits in release changelogs", () => {
  for (const subject of [
    "fix(web): display CI status",
    "feat: add release notifications",
    "docs: explain CI quality gates",
    "fix(web, release): display build status",
    "Fix the CI workflow",
  ]) {
    assert.equal(isCiReleaseCommit(subject), false, subject);
  }
});

it("does not attribute upstream commits to the fork after a rebase", () => {
  const fixtureRoot = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-release-changelog-"));

  try {
    runGit(fixtureRoot, "init");
    runGit(fixtureRoot, "config", "user.name", "Release Changelog Test");
    runGit(fixtureRoot, "config", "user.email", "release-changelog@example.com");

    commitFile(fixtureRoot, "base.txt", "base\n", "feat: base");
    runGit(fixtureRoot, "switch", "-c", "previous-release");
    commitFile(fixtureRoot, "fork-one.txt", "fork one\n", "feat(fork): first change (#1)");
    runGit(fixtureRoot, "tag", "previous-release-tag");

    runGit(fixtureRoot, "switch", "-c", "upstream", "HEAD~1");
    const upstreamCommit = commitFile(
      fixtureRoot,
      "upstream.txt",
      "upstream\n",
      "feat(web): upstream change (#5000)",
    );

    runGit(fixtureRoot, "switch", "-c", "fork-source", "previous-release-tag");
    runGit(fixtureRoot, "rebase", "upstream");
    const rebasedForkCommit = runGit(fixtureRoot, "rev-parse", "HEAD");
    const forkCommit = commitFile(
      fixtureRoot,
      "fork-two.txt",
      "fork two\n",
      "feat(fork): second change (#2)",
    );

    const commits = listForkReleaseCommits(
      fixtureRoot,
      "previous-release-tag",
      "fork-source",
      "upstream",
    );

    assert.deepEqual(commits, [forkCommit]);
    assert.equal(commits.includes(upstreamCommit), false);
    assert.deepEqual(listForkReleaseCommits(fixtureRoot, "", "fork-source", "upstream"), [
      rebasedForkCommit,
      forkCommit,
    ]);
  } finally {
    NodeFs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
