// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const helperPath = NodePath.resolve(repoRoot, ".github/scripts/release-changelog.sh");

function createFixture(): string {
  const scratchRoot = NodePath.join(repoRoot, ".scratch");
  NodeFS.mkdirSync(scratchRoot, { recursive: true });
  const fixtureRoot = NodeFS.mkdtempSync(NodePath.join(scratchRoot, "release-changelog-test-"));
  runGit(fixtureRoot, "init");
  runGit(fixtureRoot, "config", "user.name", "Release Changelog Test");
  runGit(fixtureRoot, "config", "user.email", "release-changelog@example.com");
  return fixtureRoot;
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
  NodeFS.writeFileSync(NodePath.join(cwd, fileName), contents);
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

it("does not attribute upstream commits to the fork after a rebase", () => {
  const fixtureRoot = createFixture();

  try {
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
    NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

it.each([
  {
    name: "fork pull request",
    message: "fix: synthetic change (#42)",
    lookupOutput: "release-author",
    lookupStatus: 0,
    pullRepository: "example/fork",
    author: "release-author",
  },
  {
    name: "cherry-picked upstream pull request",
    message: "fix: synthetic change (#42)\n\nUpstream-PR: 42",
    lookupOutput: "upstream-author",
    lookupStatus: 0,
    pullRepository: "pingdotgg/t3code",
    author: "upstream-author",
  },
  {
    name: "comma-separated upstream provenance",
    message: "fix: synthetic change (#42)\n\nupstream-pr: 41, 42",
    lookupOutput: "upstream-author",
    lookupStatus: 0,
    pullRepository: "pingdotgg/t3code",
    author: "upstream-author",
  },
  {
    name: "fork squash with a distinct upstream source PR",
    message: "fix: synthetic change (#42)\n\nUpstream-PR: 142",
    lookupOutput: "release-author",
    lookupStatus: 0,
    pullRepository: "example/fork",
    author: "release-author",
  },
  {
    name: "404 response body on stdout",
    message: "fix: synthetic change (#42)\n\nUpstream-PR: 42",
    lookupOutput:
      '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/pulls/pulls#get-a-pull-request","status":"404"}',
    lookupStatus: 1,
    pullRepository: "pingdotgg/t3code",
    author: "",
  },
  {
    name: "rate-limited lookup",
    message: "fix: synthetic change (#42)",
    lookupOutput: '{"message":"API rate limit exceeded","status":"403"}',
    lookupStatus: 1,
    pullRepository: "example/fork",
    author: "",
  },
  {
    name: "missing author",
    message: "fix: synthetic change (#42)",
    lookupOutput: "",
    lookupStatus: 0,
    pullRepository: "example/fork",
    author: "",
  },
  {
    name: "malformed author",
    message: "fix: synthetic change (#42)",
    lookupOutput: '{"message":"unexpected response"}',
    lookupStatus: 0,
    pullRepository: "example/fork",
    author: "",
  },
  {
    name: "bot author",
    message: "fix: synthetic change (#42)",
    lookupOutput: "release-bot[bot]",
    lookupStatus: 0,
    pullRepository: "example/fork",
    author: "release-bot[bot]",
  },
  {
    name: "commit without a pull request",
    message: "fix: synthetic change",
    lookupOutput: "",
    lookupStatus: 0,
    pullRepository: "",
    author: "",
  },
])("renders $name", ({ message, lookupOutput, lookupStatus, pullRepository, author }) => {
  const fixtureRoot = createFixture();
  try {
    const sha = commitFile(fixtureRoot, "change.txt", "synthetic change\n", message);
    const lookupLog = NodePath.join(fixtureRoot, "lookups.txt");
    NodeFS.writeFileSync(lookupLog, "");
    const result = NodeChildProcess.spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
source "$1"
lookup_output="$3"
lookup_status="$4"
lookup_log="$5"
gh() {
  printf '%s\\n' "$2" >> "$lookup_log"
  printf '%s\\n' "$lookup_output"
  return "$lookup_status"
}
append_release_changes example/fork "$2"`,
        "release-changelog-test",
        helperPath,
        sha,
        lookupOutput,
        String(lookupStatus),
        lookupLog,
      ],
      { cwd: fixtureRoot, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    const subject = message.split("\n")[0];
    const expected =
      lookupStatus === 0 && pullRepository !== ""
        ? `- fix: synthetic change ([${pullRepository}#42](https://github.com/${pullRepository}/pull/42))${author === "" ? "" : ` by @${author}`}\n`
        : `- ${subject} ([\`${sha.slice(0, 7)}\`](https://github.com/example/fork/commit/${sha}))\n`;
    assert.equal(result.stdout, expected);
    assert.equal(
      NodeFS.readFileSync(lookupLog, "utf8"),
      pullRepository === "" ? "" : `repos/${pullRepository}/pulls/42\n`,
    );
  } finally {
    NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

it("keeps repository attribution local to each entry in a mixed release", () => {
  const fixtureRoot = createFixture();
  try {
    const upstreamSha = commitFile(
      fixtureRoot,
      "upstream.txt",
      "upstream change\n",
      "fix: upstream change (#42)\n\nUpstream-PR: 42",
    );
    const forkSha = commitFile(fixtureRoot, "fork.txt", "fork change\n", "fix: fork change (#43)");
    const result = NodeChildProcess.spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
source "$1"
gh() { printf 'release-author\\n'; }
append_release_changes example/fork
append_release_changes example/fork "$2" "$3"`,
        "release-changelog-test",
        helperPath,
        upstreamSha,
        forkSha,
      ],
      { cwd: fixtureRoot, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      "- fix: upstream change ([pingdotgg/t3code#42](https://github.com/pingdotgg/t3code/pull/42)) by @release-author\n" +
        "- fix: fork change ([example/fork#43](https://github.com/example/fork/pull/43)) by @release-author\n",
    );
  } finally {
    NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
