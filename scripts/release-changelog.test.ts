// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
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
