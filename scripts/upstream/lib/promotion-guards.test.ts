// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { parse } from "yaml";
import { requiredIntakeJobs, requiredIntakeSteps } from "./promotion-evidence.ts";

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
  assert.isAtLeast(job["timeout-minutes"], 200);
  const checks = job.steps.find(
    (entry: { name?: string }) => entry.name === "Wait for main's required checks on the candidate",
  );
  assert.isBelow(job.steps.indexOf(step), job.steps.indexOf(checks));
  assert.isUndefined(checks.if);
  assert.equal(checks.run, "node scripts/upstream/wait-required-checks.ts");
  NodeChildProcess.execFileSync("git", ["check-ignore", "-q", ".scratch/"], { cwd: root });
  NodeFS.mkdirSync(NodePath.join(root, ".scratch"), { recursive: true });
  const directory = NodeFS.mkdtempSync(NodePath.join(root, ".scratch/intake-readiness-"));
  const sha = "a".repeat(40);
  const old = "b".repeat(40);
  try {
    NodeFS.writeFileSync(
      NodePath.join(directory, "gh"),
      `#!/usr/bin/env node
import fs from 'node:fs';
const path = process.argv.at(-1);
const clock = process.env.FIXTURE_CLOCK;
const now = Number(fs.readFileSync(clock, 'utf8'));
const elapsed = process.env.FIXTURE === 'late-ready' ? 9000 : process.env.FIXTURE === 'slow-missing' ? (now === 0 ? 8950 : 20) : 0;
fs.writeFileSync(clock, String(now + elapsed));
if (path !== 'repos/incognitojam/styal/commits/${sha}/status?per_page=100') process.exit(2);
const statuses = ['missing', 'slow-missing'].includes(process.env.FIXTURE) ? [] : [{ context: 'Intake ready', state: process.env.FIXTURE === 'pending' ? 'pending' : 'success' }];
console.log(JSON.stringify([{ sha: process.env.FIXTURE === 'old' ? '${old}' : '${sha}', statuses }]));
`,
      { mode: 0o755 },
    );
    NodeFS.writeFileSync(NodePath.join(directory, "date"), '#!/bin/sh\ncat "$FIXTURE_CLOCK"\n', {
      mode: 0o755,
    });
    NodeFS.writeFileSync(
      NodePath.join(directory, "sleep"),
      `#!/usr/bin/env node
import fs from 'node:fs';
const clock = process.env.FIXTURE_CLOCK;
const elapsed = process.env.FIXTURE === 'slow-missing' ? Number(process.argv[2]) : 9000;
fs.writeFileSync(clock, String(Number(fs.readFileSync(clock, 'utf8')) + elapsed));
`,
      { mode: 0o755 },
    );
    NodeFS.writeFileSync(
      NodePath.join(directory, "timeout"),
      '#!/bin/sh\nshift\necho "$1" >> "$FIXTURE_BUDGETS"\nshift\nexec "$@"\n',
      { mode: 0o755 },
    );
    for (const [event, lane, fixture, expected] of [
      ["workflow_run", "manual", "missing", 1],
      ["workflow_run", "manual", "old", 1],
      ["workflow_run", "manual", "pending", 1],
      ["workflow_run", "manual", "ready", 0],
      ["workflow_run", "automatic", "missing", 0],
      ["workflow_run", "manual", "late-ready", 1],
      ["workflow_run", "manual", "slow-missing", 1],
      ["workflow_dispatch", "manual", "missing", 0],
      ["workflow_dispatch", "manual", "old", 0],
      ["workflow_dispatch", "manual", "pending", 0],
      ["workflow_dispatch", "manual", "ready", 0],
    ] as const) {
      const summary = NodePath.join(directory, "summary");
      NodeFS.writeFileSync(summary, "");
      const clock = NodePath.join(directory, "clock");
      const budgets = NodePath.join(directory, "budgets");
      NodeFS.writeFileSync(clock, "0");
      NodeFS.writeFileSync(budgets, "");
      const result = NodeChildProcess.spawnSync("bash", ["-c", step.run], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}${NodePath.delimiter}${process.env.PATH ?? ""}`,
          GITHUB_REPOSITORY: "incognitojam/styal",
          GITHUB_EVENT_NAME: event,
          CANDIDATE_SHA: sha,
          PROMOTION_LANE: lane,
          FIXTURE: fixture,
          FIXTURE_CLOCK: clock,
          FIXTURE_BUDGETS: budgets,
          GITHUB_STEP_SUMMARY: summary,
        },
      });
      assert.equal(result.status, expected, `${event}/${lane}/${fixture}: ${result.stderr}`);
      if (fixture === "slow-missing") {
        assert.equal(NodeFS.readFileSync(clock, "utf8"), "9000");
        assert.equal(NodeFS.readFileSync(budgets, "utf8"), "60s\n20s\n");
      }
      assert.include(
        NodeFS.readFileSync(summary, "utf8"),
        expected === 1
          ? "No approval requested"
          : lane === "automatic"
            ? "Automatic lane"
            : event === "workflow_dispatch" && fixture !== "ready"
              ? "Dry run: Intake ready is missing or unsuccessful"
              : "Coordinator ready",
      );
    }
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps the triggering Fork CI attempt as evidence when promotion is rerun", () => {
  const root = NodePath.resolve(import.meta.dirname, "../../..");
  const workflow = parse(
    NodeFS.readFileSync(
      NodePath.join(root, ".github/workflows/promote-upstream-intake.yml"),
      "utf8",
    ),
  );
  const evidence = workflow.jobs.validate.steps.find(
    (step: { id?: string }) => step.id === "evidence",
  );
  const checks = workflow.jobs.validate.steps.find(
    (step: { name?: string }) =>
      step.name === "Require executed Fork CI jobs from the triggering attempt",
  );
  assert.equal(evidence.env.CI_RUN_ATTEMPT, "${{ github.event.workflow_run.run_attempt }}");
  assert.equal(checks.env.CI_RUN_ATTEMPT, "${{ steps.evidence.outputs.ci_run_attempt }}");
  NodeChildProcess.execFileSync("git", ["check-ignore", "-q", ".scratch/"], { cwd: root });
  NodeFS.mkdirSync(NodePath.join(root, ".scratch"), { recursive: true });
  const directory = NodeFS.mkdtempSync(NodePath.join(root, ".scratch/intake-readiness-retry-"));
  const sha = "a".repeat(40);
  try {
    const run = {
      id: 123,
      run_attempt: 3,
      head_sha: sha,
      head_branch: "intake/fixture",
      event: "push",
      path: ".github/workflows/fork-ci.yml",
      conclusion: "success",
      html_url: "https://example.invalid/run",
    };
    const jobs = requiredIntakeJobs.map((name) => ({
      name,
      status: "completed",
      conclusion: "success",
      steps: requiredIntakeSteps(name).map((name) => ({ name, conclusion: "success" })),
    }));
    NodeFS.writeFileSync(
      NodePath.join(directory, "gh"),
      `#!/usr/bin/env node
const path = process.argv.at(-1);
const root = 'repos/incognitojam/styal/actions/runs/123/attempts/3';
if (path === root) console.log(${JSON.stringify(JSON.stringify(run))});
else if (path === root + '/jobs?per_page=100') console.log(${JSON.stringify(JSON.stringify([{ jobs }]))});
else process.exit(2);
`,
      { mode: 0o755 },
    );
    for (const attempt of ["1", "2"]) {
      const output = NodePath.join(directory, "outputs");
      NodeFS.writeFileSync(output, "");
      const env = {
        ...process.env,
        PATH: `${directory}${NodePath.delimiter}${process.env.PATH ?? ""}`,
        GITHUB_REPOSITORY: "incognitojam/styal",
        GITHUB_RUN_ATTEMPT: attempt,
        CI_RUN_ID: "123",
        CI_RUN_ATTEMPT: "3",
        CANDIDATE_SHA: sha,
        GITHUB_OUTPUT: output,
      };
      for (const step of [evidence, checks]) {
        const result = NodeChildProcess.spawnSync("bash", ["-c", step.run], {
          cwd: root,
          encoding: "utf8",
          env,
        });
        assert.equal(result.status, 0, result.stderr);
      }
      assert.include(NodeFS.readFileSync(output, "utf8"), "ci_run_attempt=3\n");
    }
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
