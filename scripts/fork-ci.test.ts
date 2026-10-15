// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";
import { parse } from "yaml";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const workflow = parse(
  NodeFS.readFileSync(NodePath.join(repoRoot, ".github/workflows/fork-ci.yml"), "utf8"),
) as {
  jobs: {
    changes: { steps: Array<{ id?: string; run?: string }> };
    check: { steps: Array<{ run: string }> };
  };
};
const filterScript = workflow.jobs.changes.steps.find((step) => step.id === "filter")!.run!;

/** Run the actual workflow classifier against synthetic commits, including Git rename detection. */
function classify(paths: string[], options: { invalidBase?: boolean; rename?: boolean } = {}) {
  NodeChildProcess.execFileSync("git", ["check-ignore", "-q", ".scratch"], { cwd: repoRoot });
  NodeFS.mkdirSync(NodePath.join(repoRoot, ".scratch"), { recursive: true });
  const fixture = NodeFS.mkdtempSync(NodePath.join(repoRoot, ".scratch/ci-metadata-cuts-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture Agent",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Fixture Agent",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
  };
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd: fixture, env, encoding: "utf8" }).trim();
  const write = (path: string) => {
    const destination = NodePath.join(fixture, path);
    NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
    NodeFS.writeFileSync(
      destination,
      NodeFS.existsSync(destination) ? "changed synthetic fixture\n" : "synthetic fixture\n",
    );
  };
  try {
    git("-c", "init.templateDir=", "init", "--quiet");
    write("apps/server/example.ts");
    git("add", ".");
    git("commit", "--quiet", "-m", "fixture: base");
    const base = git("rev-parse", "HEAD");
    for (const path of paths) write(path);
    if (options.rename) {
      NodeFS.mkdirSync(NodePath.join(fixture, "docs"), { recursive: true });
      git("mv", "apps/server/example.ts", "docs/example.md");
    }
    git("add", ".");
    git("commit", "--quiet", "-m", "fixture: change");
    const outputPath = NodePath.join(fixture, "outputs");
    NodeChildProcess.execFileSync("bash", ["-e", "-o", "pipefail", "-c", filterScript], {
      cwd: fixture,
      env: {
        ...env,
        BASE_SHA: options.invalidBase ? "missing-commit" : base,
        HEAD_SHA: git("rev-parse", "HEAD"),
        GITHUB_REF: "refs/pull/1/merge",
        GITHUB_OUTPUT: outputPath,
        RUNNER_TEMP: fixture,
      },
    });
    return Object.fromEntries(
      NodeFS.readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
  } finally {
    NodeFS.rmSync(fixture, { recursive: true, force: true });
  }
}

describe("Fork CI metadata cuts", () => {
  it("keeps ledger validation while skipping application checks for ledger and documentation changes", () => {
    assert.deepEqual(classify([".github/fork-features.yml", "docs/guide.md"]), {
      run_ci: "false",
      ledger_changed: "true",
    });
  });

  it("keeps documentation-only changes lightweight", () => {
    assert.deepEqual(classify(["README.md", "docs/guide.md"]), {
      run_ci: "false",
      ledger_changed: "false",
    });
  });

  it.each(["apps/server/example.ts", ".github/workflows/fork-ci.yml", "unknown.yml"])(
    "runs full CI when ledger changes accompany %s",
    (path) => {
      assert.equal(classify([".github/fork-features.yml", path]).run_ci, "true");
    },
  );

  it("runs full CI when a runtime file is renamed into documentation", () => {
    assert.equal(classify([], { rename: true }).run_ci, "true");
  });

  it("runs full CI when the diff cannot be resolved", () => {
    assert.equal(classify([".github/fork-features.yml"], { invalidBase: true }).run_ci, "true");
  });

  it("fails Fork Check when classification or ledger validation fails", () => {
    const gateScript = workflow.jobs.check.steps[0]!.run;
    const runGate = (result: string) =>
      NodeChildProcess.execFileSync("bash", [
        "-e",
        "-c",
        gateScript.replace("${{ needs.changes.result }}", result),
      ]);
    assert.doesNotThrow(() => runGate("success"));
    assert.throws(() => runGate("failure"));
  });
});
