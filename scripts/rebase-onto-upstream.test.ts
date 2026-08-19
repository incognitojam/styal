// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";
import { parse } from "yaml";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const rebaseScript = NodePath.resolve(repoRoot, ".github/scripts/rebase-onto-upstream.sh");
const nightlyWorkflow = NodePath.resolve(repoRoot, ".github/workflows/fork-nightly.yml");

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
}

function findWorkflowStep(name: string): WorkflowStep {
  const workflow = parse(NodeFS.readFileSync(nightlyWorkflow, "utf8")) as {
    readonly jobs: {
      readonly prepare: {
        readonly steps: ReadonlyArray<WorkflowStep>;
      };
    };
  };
  const step = workflow.jobs.prepare.steps.find((candidate) => candidate.name === name);
  if (step === undefined) throw new Error(`Could not find workflow step: ${name}`);
  return step;
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

function runRebase(
  cwd: string,
  upstreamRef: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeChildProcess.SpawnSyncReturns<string> {
  return NodeChildProcess.spawnSync("bash", [rebaseScript, upstreamRef], {
    cwd,
    encoding: "utf8",
    env,
  });
}

function withRepository(run: (fixtureRoot: string, baseRef: string) => void): void {
  const fixtureRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-rebase-"));

  try {
    runGit(fixtureRoot, "init");
    runGit(fixtureRoot, "symbolic-ref", "HEAD", "refs/heads/main");
    runGit(fixtureRoot, "config", "user.name", "Fork Rebase Test");
    runGit(fixtureRoot, "config", "user.email", "fork-rebase@example.com");
    const baseRef = commitFile(fixtureRoot, "base.txt", "base\n", "feat: upstream base");
    run(fixtureRoot, baseRef);
  } finally {
    NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

describe("fork upstream rebase policy", () => {
  it("replays fork patches onto a newer upstream base", () => {
    withRepository((fixtureRoot, baseRef) => {
      commitFile(fixtureRoot, "fork.txt", "fork\n", "feat: retained fork patch");

      runGit(fixtureRoot, "switch", "-c", "upstream-next", baseRef);
      const upstreamRef = commitFile(
        fixtureRoot,
        "upstream.txt",
        "upstream\n",
        "feat: newer upstream change",
      );
      runGit(fixtureRoot, "switch", "main");

      const result = runRebase(fixtureRoot, upstreamRef);

      assert.equal(result.status, 0, result.stderr);
      assert.equal(NodeFS.readFileSync(NodePath.join(fixtureRoot, "fork.txt"), "utf8"), "fork\n");
      assert.equal(
        NodeFS.readFileSync(NodePath.join(fixtureRoot, "upstream.txt"), "utf8"),
        "upstream\n",
      );
      assert.equal(runGit(fixtureRoot, "config", "--local", "user.name"), "Fork Rebase Test");
      assert.equal(
        runGit(fixtureRoot, "config", "--local", "user.email"),
        "fork-rebase@example.com",
      );
      assert.equal(
        runGit(fixtureRoot, "show", "--no-patch", "--format=%cn <%ce>", "HEAD"),
        "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
      );
    });
  });

  it("stops when upstream has absorbed a fork patch", () => {
    withRepository((fixtureRoot, baseRef) => {
      const forkPatch = commitFile(
        fixtureRoot,
        "feature.txt",
        "accepted upstream\n",
        "feat: fork feature",
      );

      runGit(fixtureRoot, "switch", "-c", "upstream-next", baseRef);
      runGit(fixtureRoot, "cherry-pick", forkPatch);
      runGit(fixtureRoot, "commit", "--amend", "-m", "feat: upstream version");
      const upstreamRef = runGit(fixtureRoot, "rev-parse", "HEAD");
      runGit(fixtureRoot, "switch", "main");

      const result = runRebase(fixtureRoot, upstreamRef);

      assert.equal(result.status, 1);
      assert.equal(runGit(fixtureRoot, "rev-parse", "REBASE_HEAD"), forkPatch);
      assert.include(result.stderr, "Fork patch rebase needs review");
      runGit(fixtureRoot, "rebase", "--abort");
    });
  });

  it("stops on a content conflict", () => {
    withRepository((fixtureRoot, baseRef) => {
      const forkPatch = commitFile(
        fixtureRoot,
        "base.txt",
        "fork version\n",
        "feat: fork edits shared behavior",
      );

      runGit(fixtureRoot, "switch", "-c", "upstream-next", baseRef);
      const upstreamRef = commitFile(
        fixtureRoot,
        "base.txt",
        "upstream version\n",
        "feat: upstream edits shared behavior",
      );
      runGit(fixtureRoot, "switch", "main");

      const result = runRebase(fixtureRoot, upstreamRef);

      assert.equal(result.status, 1);
      assert.equal(runGit(fixtureRoot, "rev-parse", "REBASE_HEAD"), forkPatch);
      assert.include(result.stderr, "Fork patch rebase needs review");
      runGit(fixtureRoot, "rebase", "--abort");
    });
  });

  it("writes the successful patch mapping to the workflow summary", () => {
    withRepository((fixtureRoot, baseRef) => {
      commitFile(fixtureRoot, "fork.txt", "fork\n", "feat: summarized fork patch");

      runGit(fixtureRoot, "switch", "-c", "upstream-next", baseRef);
      const upstreamRef = commitFile(
        fixtureRoot,
        "upstream.txt",
        "upstream\n",
        "feat: summarized upstream patch",
      );
      runGit(fixtureRoot, "switch", "main");
      const summaryPath = NodePath.join(fixtureRoot, "summary.md");

      const result = runRebase(fixtureRoot, upstreamRef, {
        ...process.env,
        GITHUB_STEP_SUMMARY: summaryPath,
      });

      assert.equal(result.status, 0, result.stderr);
      const summary = NodeFS.readFileSync(summaryPath, "utf8");
      assert.include(summary, "## Fork patch range-diff");
      assert.include(summary, "feat: summarized fork patch");
    });
  });

  it("keeps a successful rebase when range-diff reporting fails", () => {
    withRepository((fixtureRoot, baseRef) => {
      commitFile(fixtureRoot, "fork.txt", "fork\n", "feat: retained despite report failure");

      runGit(fixtureRoot, "switch", "-c", "upstream-next", baseRef);
      const upstreamRef = commitFile(
        fixtureRoot,
        "upstream.txt",
        "upstream\n",
        "feat: upstream before report failure",
      );
      runGit(fixtureRoot, "switch", "main");
      const wrapperDirectory = NodePath.join(fixtureRoot, "bin");
      const gitWrapper = NodePath.join(wrapperDirectory, "git");
      NodeFS.mkdirSync(wrapperDirectory);
      NodeFS.writeFileSync(
        gitWrapper,
        `#!/bin/sh
if [ "$1" = "range-diff" ]; then
  exit 42
fi
PATH="$ORIGINAL_PATH" exec git "$@"
`,
      );
      NodeFS.chmodSync(gitWrapper, 0o755);

      const result = runRebase(fixtureRoot, upstreamRef, {
        ...process.env,
        GITHUB_STEP_SUMMARY: NodePath.join(fixtureRoot, "summary.md"),
        ORIGINAL_PATH: process.env.PATH,
        PATH: `${wrapperDirectory}:${process.env.PATH}`,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.include(result.stderr, "Fork patch range-diff unavailable");
      assert.equal(NodeFS.readFileSync(NodePath.join(fixtureRoot, "fork.txt"), "utf8"), "fork\n");
    });
  });

  it("promotes a tree-equivalent candidate instead of restoring nightly history", () => {
    withRepository((fixtureRoot, mainRef) => {
      const remoteRoot = NodePath.join(fixtureRoot, "origin.git");
      runGit(fixtureRoot, "init", "--bare", remoteRoot);
      runGit(fixtureRoot, "remote", "add", "origin", remoteRoot);
      runGit(fixtureRoot, "push", "origin", `${mainRef}:refs/heads/main`);
      runGit(fixtureRoot, "commit", "--allow-empty", "-m", "chore: advance fork history");
      const candidateRef = runGit(fixtureRoot, "rev-parse", "HEAD");
      const step = findWorkflowStep("Promote tree-equivalent candidate to main");
      if (step.run === undefined) throw new Error("Tree-equivalent promotion step has no script.");

      const result = NodeChildProcess.spawnSync("bash", ["-c", step.run], {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CANDIDATE_REF: candidateRef,
          MAIN_REF: mainRef,
          SOURCE_REF: "",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        runGit(fixtureRoot, "--git-dir", remoteRoot, "rev-parse", "refs/heads/main"),
        candidateRef,
      );
      assert.equal(
        runGit(
          fixtureRoot,
          "--git-dir",
          remoteRoot,
          "for-each-ref",
          "--format=%(objectname)",
          "refs/heads/backup/",
        ),
        mainRef,
      );
    });
  });
});
