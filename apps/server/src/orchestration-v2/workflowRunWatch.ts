import type { OrchestrationV2Notification, ThreadWorkflowRunWatch } from "@t3tools/contracts";

import type { ProviderWorkflowRun } from "@t3tools/source-control-core/server/PullRequestProvider";

const LISTED_JOBS = 10;

/** Conclusions that mean the run did what it was asked; anything else is reported as failed. */
const PASSED = new Set(["success", "skipped", "neutral"]);

type FailedJob = ProviderWorkflowRun["failedJobs"][number];

const whereRan = (run: ProviderWorkflowRun) =>
  [run.headBranch === null ? null : `on ${run.headBranch}`, `at ${run.headSha.slice(0, 7)}`]
    .filter((part) => part !== null)
    .join(" ");

const jobLines = (failed: ReadonlyArray<FailedJob>) => {
  const lines = failed
    .slice(0, LISTED_JOBS)
    .map(
      (job) =>
        `  - ${job.name}${job.conclusion === "failure" ? "" : ` (${job.conclusion ?? "unknown"})`}${job.url ? ` ${job.url}` : ""}`,
    );
  if (failed.length > LISTED_JOBS) lines.push(`  - and ${failed.length - LISTED_JOBS} more`);
  return lines;
};

/** The failed jobs of `run` the agent has not been told about yet. */
export function newlyFailedJobs(
  watch: Pick<ThreadWorkflowRunWatch, "failedJobs">,
  run: ProviderWorkflowRun,
): ReadonlyArray<FailedJob> {
  const told = new Set(watch.failedJobs ?? []);
  return run.failedJobs.filter((job) => !told.has(job.name));
}

/** The wake sent while a watched run is still going, when some of its jobs failed. */
export function workflowRunJobsFailedMessage(
  watch: Pick<ThreadWorkflowRunWatch, "name">,
  run: ProviderWorkflowRun,
  failed: ReadonlyArray<FailedJob>,
): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const text = [
    `Update on workflow run ${run.name} (${run.url}) ${whereRan(run)}, which styal is watching for you. It is still running, and these jobs failed:`,
    ...jobLines(failed),
    "",
    "Act on the failures as your task requires. The run stays watched, so do not watch it again. End your turn when you are done, and styal wakes you if another job fails and once the run finishes.",
  ].join("\n");
  return {
    text,
    notification: {
      source: { kind: "monitor" },
      outcome: "failed",
      summary: `${watch.name}: ${failed.length === 1 ? "a job" : `${failed.length} jobs`} failed`,
    },
  };
}

/** The wake the agent reads, and the timeline notification the user sees, when a run completes. */
export function workflowRunCompletedMessage(
  watch: Pick<ThreadWorkflowRunWatch, "name" | "url" | "failedJobs">,
  run: ProviderWorkflowRun,
): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const conclusion = run.conclusion ?? "unknown";
  const passed = PASSED.has(conclusion);
  const failed = newlyFailedJobs(watch, run);
  const reported = run.failedJobs.length - failed.length;
  const text = [
    `Workflow run ${run.name} (${run.url}) ${whereRan(run)}, which styal was watching for you, finished: ${conclusion}.`,
    ...(failed.length === 0
      ? []
      : [
          reported === 0 ? "Jobs that did not pass:" : "Other jobs that did not pass:",
          ...jobLines(failed),
        ]),
    ...(reported === 0
      ? []
      : [
          `${reported === 1 ? "1 failed job was" : `${reported} failed jobs were`} reported to you while the run was going.`,
        ]),
    "",
    "styal stopped watching it. Act on the result as your task requires. To wait for a rerun, call watch_workflow_run with the run again after starting it.",
  ].join("\n");
  return {
    text,
    notification: {
      source: { kind: "monitor" },
      outcome: passed ? "completed" : conclusion === "cancelled" ? "cancelled" : "failed",
      summary: `${watch.name}: ${conclusion}`,
    },
  };
}

/** The wake sent when a run could not be read often enough to keep watching it. */
export function workflowRunUnreadableMessage(
  watch: Pick<ThreadWorkflowRunWatch, "name" | "url">,
  failures: number,
): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  return {
    text: `styal stopped watching workflow run ${watch.name} (${watch.url}) because it failed to read it from the host ${failures} times in a row. Check it yourself, and call watch_workflow_run to watch it again.`,
    notification: {
      source: { kind: "monitor" },
      outcome: "failed",
      summary: `${watch.name}: stopped watching, could not read it`,
    },
  };
}
