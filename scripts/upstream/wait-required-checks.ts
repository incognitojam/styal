#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - Maintainer CI CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

interface RequiredCheck {
  readonly context: string;
  readonly integration_id?: number | null;
}
interface CheckRun {
  readonly id: number;
  readonly name: string;
  readonly check_suite: { readonly id: number };
  readonly app: { readonly id: number };
  readonly status: string;
  readonly conclusion: string | null;
}
interface CheckSuite {
  readonly id: number;
  readonly app: { readonly id: number };
  readonly status: string;
}
interface WorkflowRun {
  readonly id: number;
  readonly workflow_id: number;
  readonly check_suite_id: number;
  readonly status: string;
}
interface Status {
  readonly id: number;
  readonly context: string;
  readonly state: string;
}
interface Rule {
  readonly type: string;
  readonly parameters?: { readonly required_status_checks?: ReadonlyArray<RequiredCheck> };
}

export function requiredCheckStates(
  rules: ReadonlyArray<Rule>,
  runs: ReadonlyArray<CheckRun>,
  statuses: ReadonlyArray<Status>,
  suites: ReadonlyArray<CheckSuite> = [],
  workflows: ReadonlyArray<WorkflowRun> = [],
): ReadonlyArray<{ context: string; state: string }> {
  const required = rules.flatMap((rule) =>
    rule.type === "required_status_checks" ? (rule.parameters?.required_status_checks ?? []) : [],
  );
  if (required.length === 0) throw new Error("No required status checks found in main's rules.");
  return required.map(({ context, integration_id }) => {
    const run = runs
      .filter((run) => run.name === context && (!integration_id || run.app.id === integration_id))
      .sort((a, b) => b.id - a.id)[0];
    const owner = workflows.find((workflow) => workflow.check_suite_id === run?.check_suite.id);
    const latest =
      owner &&
      workflows
        .filter((workflow) => workflow.workflow_id === owner.workflow_id)
        .sort((a, b) => b.id - a.id)[0];
    // A rerun can exist before its replacement jobs do; old green jobs are not evidence for it.
    const replacing =
      run &&
      (suites.some((suite) => suite.id === run.check_suite.id && suite.status !== "completed") ||
        (latest &&
          (latest.status !== "completed" || latest.check_suite_id !== run.check_suite.id)) ||
        suites.some(
          (suite) =>
            suite.app.id === run.app.id &&
            suite.id > run.check_suite.id &&
            !workflows.some((workflow) => workflow.check_suite_id === suite.id),
        ));
    const status = !integration_id
      ? statuses.filter((status) => status.context === context).sort((a, b) => b.id - a.id)[0]
      : undefined;
    // A required context can be both a check run and a commit status; both must pass.
    const states = [
      ...(run
        ? [
            run.status === "completed" && !replacing
              ? ["success", "neutral", "skipped"].includes(run.conclusion ?? "")
                ? "success"
                : (run.conclusion ?? "pending")
              : "pending",
          ]
        : []),
      ...(status ? [status.state] : []),
    ];
    const failed = states.find((state) => !["success", "pending"].includes(state));
    return {
      context,
      state:
        failed ?? (states.length && states.every((s) => s === "success") ? "success" : "pending"),
    };
  });
}

export async function waitRequiredChecks(
  read: () => ReturnType<typeof requiredCheckStates>,
  options: { readonly timeoutMs: number; readonly intervalMs: number },
  clock = { now: Date.now, sleep: (ms: number) => NodeTimersPromises.setTimeout(ms) },
): Promise<void> {
  const deadline = clock.now() + options.timeoutMs;
  for (;;) {
    const states = read();
    const failed = states.filter(({ state }) => state !== "pending" && state !== "success");
    if (failed.length) {
      throw new Error(
        `Required checks failed: ${failed.map(({ context, state }) => `${context} (${state})`).join(", ")}`,
      );
    }
    const pending = states.filter(({ state }) => state !== "success").map(({ context }) => context);
    if (!pending.length) {
      console.log("All of main's required checks succeeded on the candidate.");
      return;
    }
    if (clock.now() >= deadline)
      throw new Error(`Timed out waiting for required checks: ${pending.join(", ")}`);
    console.log(`Waiting for required checks: ${pending.join(", ")}`);
    await clock.sleep(Math.min(options.intervalMs, deadline - clock.now()));
  }
}

export function readRequiredChecks(api: (path: string) => Array<unknown>, sha: string) {
  const rules = api("rules/branches/main").flat() as Array<Rule>;
  const suites = (
    api(`commits/${sha}/check-suites?per_page=100`) as Array<{
      check_suites: Array<CheckSuite>;
    }>
  ).flatMap((page) => page.check_suites);
  const workflows = (
    api(`actions/runs?head_sha=${sha}&per_page=100`) as Array<{
      workflow_runs: Array<WorkflowRun>;
    }>
  ).flatMap((page) => page.workflow_runs);
  const runs = (
    api(`commits/${sha}/check-runs?per_page=100`) as Array<{ check_runs: Array<CheckRun> }>
  ).flatMap((page) => page.check_runs);
  return requiredCheckStates(
    rules,
    runs,
    api(`commits/${sha}/statuses?per_page=100`).flat() as Array<Status>,
    suites,
    workflows,
  );
}

export async function main(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY;
  const sha = process.env.CANDIDATE_SHA;
  if (repository !== "incognitojam/styal" || !sha || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("Expected the fork repository and a full candidate SHA.");
  }
  const api = (path: string): Array<unknown> =>
    JSON.parse(
      NodeChildProcess.execFileSync(
        "gh",
        ["api", "--paginate", "--slurp", `repos/${repository}/${path}`],
        {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 64 * 1024 * 1024,
        },
      ),
    );
  await waitRequiredChecks(() => readRequiredChecks(api, sha), {
    timeoutMs: process.argv.includes("--once") ? 0 : 30 * 60_000,
    intervalMs: 15_000,
  });
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
