// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const helperPath = NodePath.resolve(repoRoot, ".github/scripts/check-source-stack.sh");

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

function checkStack(
  cwd: string,
  mainRef: string,
  candidateRef: string,
  upstreamRef: string,
  waivedPatches = "",
  env: NodeJS.ProcessEnv = process.env,
): NodeChildProcess.SpawnSyncReturns<string> {
  return NodeChildProcess.spawnSync(
    "bash",
    [helperPath, mainRef, candidateRef, upstreamRef, waivedPatches],
    { cwd, encoding: "utf8", env },
  );
}

function withRepository(run: (fixtureRoot: string, upstreamRef: string) => void): void {
  const fixtureRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-source-stack-"));

  try {
    runGit(fixtureRoot, "init");
    runGit(fixtureRoot, "symbolic-ref", "HEAD", "refs/heads/main");
    runGit(fixtureRoot, "config", "user.name", "Source Stack Test");
    runGit(fixtureRoot, "config", "user.email", "source-stack@example.com");
    const upstreamRef = commitFile(fixtureRoot, "base.txt", "base\n", "feat: upstream base");
    run(fixtureRoot, upstreamRef);
  } finally {
    NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

describe("nightly source stack guard", () => {
  it("accepts a candidate with patch-id-equivalent main commits", () => {
    withRepository((fixtureRoot, upstreamRef) => {
      commitFile(fixtureRoot, "one.txt", "one\n", "feat: first fork patch");
      commitFile(fixtureRoot, "two.txt", "two\n", "fix: second fork patch");

      runGit(fixtureRoot, "switch", "-c", "candidate", upstreamRef);
      runGit(fixtureRoot, "cherry-pick", "main~1", "main");

      const result = checkStack(fixtureRoot, "main", "candidate", upstreamRef);

      assert.equal(result.status, 0, result.stderr);
      assert.include(result.stdout, "contains every patch currently carried by main");
    });
  });

  it("does not require upstream-only commits to be present in the candidate", () => {
    withRepository((fixtureRoot, originalUpstreamRef) => {
      runGit(fixtureRoot, "switch", "-c", "candidate");
      const candidatePatch = commitFile(
        fixtureRoot,
        "fork.txt",
        "fork\n",
        "feat: retained fork patch",
      );

      runGit(fixtureRoot, "switch", "-c", "upstream-next", originalUpstreamRef);
      const currentUpstreamRef = commitFile(
        fixtureRoot,
        "upstream.txt",
        "upstream\n",
        "feat: newer upstream change",
      );

      runGit(fixtureRoot, "switch", "main");
      runGit(fixtureRoot, "merge", "--ff-only", "upstream-next");
      runGit(fixtureRoot, "cherry-pick", candidatePatch);

      const result = checkStack(fixtureRoot, "main", "candidate", currentUpstreamRef);

      assert.equal(result.status, 0, result.stderr);
    });
  });

  it("accepts a main patch that has since been absorbed by upstream", () => {
    withRepository((fixtureRoot, originalUpstreamRef) => {
      const mainPatch = commitFile(
        fixtureRoot,
        "feature.txt",
        "fork feature\n",
        "feat: fork patch accepted upstream",
      );

      runGit(fixtureRoot, "switch", "-c", "upstream-next", originalUpstreamRef);
      runGit(fixtureRoot, "cherry-pick", mainPatch);
      runGit(fixtureRoot, "commit", "--amend", "-m", "feat: upstream version of fork patch");
      const currentUpstreamRef = runGit(fixtureRoot, "rev-parse", "HEAD");

      const result = checkStack(fixtureRoot, "main", "upstream-next", currentUpstreamRef);

      assert.equal(result.status, 0, result.stderr);
    });
  });

  it("accepts equivalent patches applied on top of a newer upstream base", () => {
    withRepository((fixtureRoot, originalUpstreamRef) => {
      const mainPatch = commitFile(
        fixtureRoot,
        "fork.txt",
        "fork\n",
        "feat: fork patch rebased after upstream",
      );

      runGit(fixtureRoot, "switch", "-c", "upstream-next", originalUpstreamRef);
      const currentUpstreamRef = commitFile(
        fixtureRoot,
        "upstream.txt",
        "new upstream\n",
        "feat: newer upstream base",
      );
      runGit(fixtureRoot, "switch", "-c", "candidate");
      runGit(fixtureRoot, "cherry-pick", mainPatch);

      const result = checkStack(fixtureRoot, "main", "candidate", currentUpstreamRef);

      assert.equal(result.status, 0, result.stderr);
    });
  });

  it("reports main patches when the candidate has no fork commits", () => {
    withRepository((fixtureRoot, upstreamRef) => {
      commitFile(fixtureRoot, "missing.txt", "missing\n", "fix: absent from empty candidate");
      runGit(fixtureRoot, "branch", "candidate", upstreamRef);

      const result = checkStack(fixtureRoot, "main", "candidate", upstreamRef);

      assert.equal(result.status, 1);
      assert.include(result.stderr, "fix: absent from empty candidate");
    });
  });

  it("fails closed when git cherry fails", () => {
    withRepository((fixtureRoot, upstreamRef) => {
      const wrapperDirectory = NodePath.join(fixtureRoot, "bin");
      const gitWrapper = NodePath.join(wrapperDirectory, "git");
      NodeFS.mkdirSync(wrapperDirectory);
      NodeFS.writeFileSync(
        gitWrapper,
        `#!/bin/sh
if [ "$1" = "cherry" ]; then
  exit 42
fi
PATH="$ORIGINAL_PATH" exec git "$@"
`,
      );
      NodeFS.chmodSync(gitWrapper, 0o755);

      const result = checkStack(fixtureRoot, "main", "main", upstreamRef, "", {
        ...process.env,
        ORIGINAL_PATH: process.env.PATH,
        PATH: `${wrapperDirectory}:${process.env.PATH}`,
      });

      assert.equal(result.status, 42);
      assert.notInclude(result.stdout, "contains every patch currently carried by main");
    });
  });

  it("fails a stale candidate and lists each missing main commit by subject", () => {
    withRepository((fixtureRoot, upstreamRef) => {
      runGit(fixtureRoot, "switch", "-c", "candidate");
      commitFile(fixtureRoot, "one.txt", "one\n", "feat: retained fork patch");

      runGit(fixtureRoot, "switch", "main");
      runGit(fixtureRoot, "merge", "--ff-only", "candidate");
      commitFile(fixtureRoot, "two.txt", "two\n", "fix: dropped workflow guard (#91)");
      commitFile(fixtureRoot, "three.txt", "three\n", "feat: dropped follow-up (#92)");

      const result = checkStack(fixtureRoot, "main", "candidate", upstreamRef);

      assert.equal(result.status, 1);
      assert.include(result.stderr, "fix: dropped workflow guard (#91)");
      assert.include(result.stderr, "feat: dropped follow-up (#92)");
      assert.include(result.stderr, "Refresh the resolution from current main");
    });
  });

  it("requires each intentionally reshaped patch to be waived by commit", () => {
    withRepository((fixtureRoot, upstreamRef) => {
      const reshapedPatch = commitFile(
        fixtureRoot,
        "feature.txt",
        "original resolution\n",
        "feat: resolved feature",
      );

      runGit(fixtureRoot, "switch", "-c", "candidate", upstreamRef);
      commitFile(fixtureRoot, "feature.txt", "reshaped resolution\n", "feat: resolved feature");

      const shortSha = runGit(fixtureRoot, "rev-parse", "--short=12", reshapedPatch);
      const rejected = checkStack(fixtureRoot, "main", "candidate", upstreamRef);
      const waived = checkStack(fixtureRoot, "main", "candidate", upstreamRef, shortSha);

      assert.equal(rejected.status, 1);
      assert.include(rejected.stderr, "waived_main_patches");
      assert.equal(waived.status, 0, waived.stderr);
      assert.include(waived.stderr, "feat: resolved feature");
      assert.include(waived.stderr, "Waived missing main patches");
    });
  });

  it("still fails on missing patches the waiver list does not cover", () => {
    withRepository((fixtureRoot, upstreamRef) => {
      const reshapedPatch = commitFile(
        fixtureRoot,
        "feature.txt",
        "original resolution\n",
        "feat: reviewed reshaped patch",
      );
      commitFile(fixtureRoot, "late.txt", "late\n", "fix: merged after the review (#96)");

      runGit(fixtureRoot, "switch", "-c", "candidate", upstreamRef);
      commitFile(
        fixtureRoot,
        "feature.txt",
        "reshaped resolution\n",
        "feat: reviewed reshaped patch",
      );

      const result = checkStack(fixtureRoot, "main", "candidate", upstreamRef, reshapedPatch);

      assert.equal(result.status, 1);
      assert.include(result.stderr, "fix: merged after the review (#96)");
      assert.include(result.stderr, "Waived missing main patches");
    });
  });

  it("rejects a waiver entry that does not resolve to a commit", () => {
    withRepository((fixtureRoot, upstreamRef) => {
      commitFile(fixtureRoot, "feature.txt", "original\n", "feat: reshaped patch");
      runGit(fixtureRoot, "branch", "candidate", upstreamRef);

      const result = checkStack(fixtureRoot, "main", "candidate", upstreamRef, "notacommit");

      assert.equal(result.status, 1);
      assert.include(result.stderr, "'notacommit' does not resolve to a commit");
    });
  });

  it("rejects the retired blanket override with pointers to the waiver list", () => {
    withRepository((fixtureRoot, upstreamRef) => {
      const result = checkStack(fixtureRoot, "main", "main", upstreamRef, "true");

      assert.equal(result.status, 1);
      assert.include(result.stderr, "waived_main_patches");
    });
  });

  it("notes waivers that turned out to be unnecessary", () => {
    withRepository((fixtureRoot, upstreamRef) => {
      const mainPatch = commitFile(fixtureRoot, "one.txt", "one\n", "feat: carried fork patch");

      runGit(fixtureRoot, "switch", "-c", "candidate", upstreamRef);
      runGit(fixtureRoot, "cherry-pick", mainPatch);

      const result = checkStack(fixtureRoot, "main", "candidate", upstreamRef, mainPatch);

      assert.equal(result.status, 0, result.stderr);
      assert.include(result.stderr, "waivers were not needed");
    });
  });
});
