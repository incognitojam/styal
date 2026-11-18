// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { parse } from "yaml";

it("blocks moved base and candidate refs before pushing, and promotes an unchanged pair", () => {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "commit.gpgSign",
    GIT_CONFIG_VALUE_1: "false",
  };
  const root = NodePath.resolve(import.meta.dirname, "../../..");
  NodeChildProcess.execFileSync("git", ["check-ignore", "-q", ".scratch/"], { cwd: root, env });
  NodeFS.mkdirSync(NodePath.join(root, ".scratch"), { recursive: true });
  const directory = NodeFS.mkdtempSync(NodePath.join(root, ".scratch/intake-followup-guards-"));
  const cwd = NodePath.join(directory, "checkout");
  const remote = NodePath.join(directory, "remote.git");
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    NodeFS.mkdirSync(cwd);
    const guardDirectory = NodePath.join(cwd, "scripts/upstream");
    NodeFS.mkdirSync(guardDirectory, { recursive: true });
    NodeFS.copyFileSync(
      NodePath.join(root, "scripts/upstream/wait-required-checks.ts"),
      NodePath.join(guardDirectory, "wait-required-checks.ts"),
    );
    const bin = NodePath.join(directory, "bin");
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(
      NodePath.join(bin, "gh"),
      `#!/usr/bin/env node
const path = process.argv.at(-1);
if (process.argv[2] !== 'api' || !path.startsWith('repos/incognitojam/styal/')) process.exit(2);
const response = path.endsWith('rules/branches/main')
  ? [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Synthetic required check' }] } }]
  : path.includes('/check-suites?') ? { check_suites: [] }
  : path.includes('/check-runs?') ? { check_runs: [] }
  : path.includes('/actions/runs?') ? { workflow_runs: [] }
  : path.includes('/statuses?') ? [{ id: 1, context: 'Synthetic required check', state: process.env.GUARD_STATE }]
  : undefined;
if (!response) process.exit(2);
console.log(JSON.stringify([response]));
`,
      { mode: 0o755 },
    );
    git("init", "--bare", remote);
    git("init", "-b", "main");
    git("config", "user.name", "Synthetic");
    git("config", "user.email", "synthetic@example.invalid");
    git("remote", "add", "origin", remote);
    const commit = (text: string) => {
      NodeFS.writeFileSync(NodePath.join(cwd, "fixture"), text);
      git("add", "fixture");
      git("commit", "-qm", "fixture");
      return git("rev-parse", "HEAD");
    };
    const base = commit("base");
    git("push", "origin", "HEAD:main");
    const head = commit("candidate");
    git("push", "origin", "HEAD:refs/heads/intake/fixture");
    const moved = commit("moved");
    const workflow = parse(
      NodeFS.readFileSync(
        NodePath.join(root, ".github/workflows/promote-upstream-intake.yml"),
        "utf8",
      ),
    );
    const resolveScript = workflow.jobs.validate.steps.find(
      (step: { name?: string }) => step.name === "Resolve candidate",
    ).run;
    const resolve = (baseSha: string, candidateSha: string) =>
      NodeChildProcess.spawnSync("bash", ["-c", resolveScript], {
        cwd,
        encoding: "utf8",
        env: {
          ...env,
          GITHUB_EVENT_NAME: "workflow_dispatch",
          DRY_RUN_BASE_SHA: baseSha,
          EXPECTED_CANDIDATE_SHA: candidateSha,
          CANDIDATE_BRANCH: "intake/fixture",
          GITHUB_OUTPUT: NodePath.join(directory, "outputs"),
          GITHUB_STEP_SUMMARY: NodePath.join(directory, "summary"),
        },
      });
    git("push", "origin", `${moved}:refs/heads/intake/fixture`);
    const unlandedBase = resolve(head, moved);
    assert.equal(unlandedBase.status, 1, unlandedBase.stderr);
    assert.include(unlandedBase.stdout, "not in main's history", unlandedBase.stderr);
    const currentBase = resolve(base, head);
    assert.equal(currentBase.status, 0, currentBase.stderr);
    git("push", "origin", `${head}:refs/heads/main`);
    const historicalBase = resolve(base, head);
    assert.equal(historicalBase.status, 0, historicalBase.stderr);
    git("push", "--force", "origin", `${base}:refs/heads/main`);
    git("push", "--force", "origin", `${head}:refs/heads/intake/fixture`);
    const script = workflow.jobs.promote.steps
      .find((step: { name?: string }) => step.name === "Fast-forward main to the candidate")
      .run.replace(/\$\{\{.*?\}\}/gu, "synthetic");
    const run = (guardState = "success") =>
      NodeChildProcess.spawnSync("bash", ["-c", script], {
        cwd,
        encoding: "utf8",
        env: {
          ...env,
          PATH: `${bin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
          GITHUB_REPOSITORY: "incognitojam/styal",
          GUARD_STATE: guardState,
          EXPECTED_BASE_SHA: base,
          CANDIDATE_SHA: head,
          CANDIDATE_BRANCH: "intake/fixture",
          CI_RUN_URL: "https://example.invalid/run",
          SOURCE_PRS: "",
          SOURCE_COMMITS: "",
          GITHUB_STEP_SUMMARY: NodePath.join(directory, "summary"),
        },
      });
    const main = () => git("ls-remote", "origin", "refs/heads/main").split(/\s/u)[0];
    git("push", "origin", `${moved}:refs/heads/main`);
    const baseMoved = run();
    assert.equal(baseMoved.status, 1);
    assert.include(baseMoved.stdout, "main moved after validation");
    assert.equal(main(), moved);
    git("push", "--force", "origin", `${base}:refs/heads/main`);
    git("push", "origin", `${moved}:refs/heads/intake/fixture`);
    const candidateMoved = run();
    assert.equal(candidateMoved.status, 1);
    assert.include(candidateMoved.stdout, "intake branch moved after validation");
    assert.equal(main(), base);
    git("push", "--force", "origin", `${head}:refs/heads/intake/fixture`);
    for (const state of ["failure", "pending"]) {
      const rejected = run(state);
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.include(
        rejected.stderr,
        state === "failure"
          ? "Required checks failed: Synthetic required check (failure)"
          : "Timed out waiting for required checks: Synthetic required check",
      );
      assert.equal(main(), base);
    }
    const unchanged = run();
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.include(unchanged.stdout, "All of main's required checks succeeded on the candidate.");
    assert.equal(main(), head);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

it("waits for exact-SHA readiness before manual approval and bypasses it for automatic promotion", () => {
  const root = NodePath.resolve(import.meta.dirname, "../../..");
  const workflow = parse(
    NodeFS.readFileSync(
      NodePath.join(root, ".github/workflows/promote-upstream-intake.yml"),
      "utf8",
    ),
  );
  const job = workflow.jobs.required_checks;
  const step = job.steps.find(
    (entry: { name?: string }) => entry.name === "Wait for coordinator readiness",
  );
  assert.isDefined(step);
  assert.deepEqual(workflow.jobs.promote.needs, ["validate", "required_checks"]);
  assert.include(workflow.jobs.promote.if, "needs.required_checks.result == 'success'");
  assert.include(workflow.jobs.promote.if, "github.event_name == 'workflow_run'");
  assert.equal(job.permissions.statuses, "read");
  assert.isAtLeast(job["timeout-minutes"], 190);
  assert.include(step.env.READINESS_CHECKS, "301");
  assert.include(step.env.READINESS_CHECKS, "workflow_dispatch");
  NodeChildProcess.execFileSync("git", ["check-ignore", "-q", ".scratch/"], { cwd: root });
  NodeFS.mkdirSync(NodePath.join(root, ".scratch"), { recursive: true });
  const directory = NodeFS.mkdtempSync(NodePath.join(root, ".scratch/intake-readiness-"));
  const sha = "a".repeat(40);
  const old = "b".repeat(40);
  try {
    NodeFS.writeFileSync(
      NodePath.join(directory, "gh"),
      `#!/usr/bin/env node
const path = process.argv.at(-1);
if (path !== 'repos/incognitojam/styal/commits/${sha}/status?per_page=100') process.exit(2);
const statuses = process.env.FIXTURE === 'missing' ? [] : [{ context: 'Intake ready', state: process.env.FIXTURE === 'pending' ? 'pending' : 'success' }];
console.log(JSON.stringify([{ sha: process.env.FIXTURE === 'old' ? '${old}' : '${sha}', statuses }]));
`,
      { mode: 0o755 },
    );
    NodeFS.writeFileSync(NodePath.join(directory, "sleep"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
    for (const [lane, fixture, expected] of [
      ["manual", "missing", 1],
      ["manual", "old", 1],
      ["manual", "pending", 1],
      ["manual", "ready", 0],
      ["automatic", "missing", 0],
    ] as const) {
      const summary = NodePath.join(directory, "summary");
      NodeFS.writeFileSync(summary, "");
      const result = NodeChildProcess.spawnSync("bash", ["-c", step.run], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}${NodePath.delimiter}${process.env.PATH ?? ""}`,
          GITHUB_REPOSITORY: "incognitojam/styal",
          CANDIDATE_SHA: sha,
          PROMOTION_LANE: lane,
          READINESS_CHECKS: "1",
          FIXTURE: fixture,
          GITHUB_STEP_SUMMARY: summary,
        },
      });
      assert.equal(result.status, expected, `${lane}/${fixture}: ${result.stderr}`);
      assert.include(
        NodeFS.readFileSync(summary, "utf8"),
        expected === 1
          ? "No approval requested"
          : lane === "automatic"
            ? "Automatic lane"
            : "Coordinator ready",
      );
    }
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
