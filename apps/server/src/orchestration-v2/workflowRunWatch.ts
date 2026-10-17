import type { OrchestrationV2Notification, ThreadWorkflowRunWatch } from "@t3tools/contracts";

import type { ProviderWorkflowRun } from "../pullRequest/PullRequestProvider.ts";

const LISTED_JOBS = 10;

/** Conclusions that mean the run did what it was asked; anything else is reported as failed. */
const PASSED = new Set(["success", "skipped", "neutral"]);

/** The wake the agent reads, and the timeline notification the user sees, when a run completes. */
export function workflowRunCompletedMessage(
  watch: Pick<ThreadWorkflowRunWatch, "name" | "url">,
  run: ProviderWorkflowRun,
): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const conclusion = run.conclusion ?? "unknown";
  const passed = PASSED.has(conclusion);
  const where = [
    run.headBranch === null ? null : `on ${run.headBranch}`,
    `at ${run.headSha.slice(0, 7)}`,
  ]
    .filter((part) => part !== null)
    .join(" ");
  const jobs = run.failedJobs
    .slice(0, LISTED_JOBS)
    .map(
      (job) =>
        `  - ${job.name}${job.conclusion === "failure" ? "" : ` (${job.conclusion ?? "unknown"})`}${job.url ? ` ${job.url}` : ""}`,
    );
  if (run.failedJobs.length > LISTED_JOBS) {
    jobs.push(`  - and ${run.failedJobs.length - LISTED_JOBS} more`);
  }
  const text = [
    `Workflow run ${run.name} (${run.url}) ${where}, which styal was watching for you, finished: ${conclusion}.`,
    ...(jobs.length === 0 ? [] : ["Jobs that did not pass:", ...jobs]),
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
