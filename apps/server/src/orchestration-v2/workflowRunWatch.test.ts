import { describe, expect, it } from "@effect/vitest";

import type { ProviderWorkflowRun } from "@t3tools/source-control-core/server/PullRequestProvider";
import {
  newlyFailedJobs,
  workflowRunCompletedMessage,
  workflowRunJobsFailedMessage,
} from "./workflowRunWatch.ts";

const watch = { name: "CI #812", url: "https://github.com/acme/app/actions/runs/1" };
const run = (overrides: Partial<ProviderWorkflowRun>): ProviderWorkflowRun => ({
  name: "CI #812",
  url: watch.url,
  completed: true,
  conclusion: "success",
  headBranch: "main",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  event: "push",
  reviewableEnvironments: [],
  failedJobs: [],
  ...overrides,
});

describe("workflowRunCompletedMessage", () => {
  it("reports a passing run as completed, with where it ran", () => {
    const message = workflowRunCompletedMessage(watch, run({}));
    expect(message.notification).toEqual({
      source: { kind: "monitor" },
      outcome: "completed",
      summary: "CI #812: success",
    });
    expect(message.text.split("\n")[0]).toBe(
      `Workflow run CI #812 (${watch.url}) on main at 0123456, which styal was watching for you, finished: success.`,
    );
    expect(message.text).not.toContain("Jobs that did not pass");
  });

  it("lists the jobs that did not pass, naming conclusions other than failure", () => {
    const failedJobs = Array.from({ length: 12 }, (_, index) => ({
      name: `job ${index}`,
      conclusion: index === 0 ? "timed_out" : "failure",
      url: index === 0 ? null : `${watch.url}/job/${index}`,
    }));
    const message = workflowRunCompletedMessage(
      watch,
      run({ conclusion: "failure", headBranch: null, failedJobs }),
    );
    expect(message.notification.outcome).toBe("failed");
    const lines = message.text.split("\n");
    expect(lines[0]).toContain(") at 0123456, which");
    expect(lines.slice(1, 4)).toEqual([
      "Jobs that did not pass:",
      "  - job 0 (timed_out)",
      `  - job 1 ${watch.url}/job/1`,
    ]);
    expect(lines).toContain("  - and 2 more");
  });

  it("reports a cancelled run as cancelled", () => {
    expect(
      workflowRunCompletedMessage(watch, run({ conclusion: "cancelled" })).notification.outcome,
    ).toBe("cancelled");
  });
});

describe("failed jobs of a running run", () => {
  const typecheck = { name: "Typecheck", conclusion: "failure", url: `${watch.url}/job/1` };
  const tests = { name: "Test", conclusion: "cancelled", url: null };

  it("counts only jobs the agent was not told about", () => {
    const running = run({ completed: false, conclusion: null, failedJobs: [typecheck, tests] });
    expect(newlyFailedJobs({}, running)).toEqual([typecheck, tests]);
    expect(newlyFailedJobs({ failedJobs: ["Typecheck"] }, running)).toEqual([tests]);
  });

  it("tells the agent the run is still going and stays watched", () => {
    const running = run({ completed: false, conclusion: null, failedJobs: [typecheck] });
    const message = workflowRunJobsFailedMessage(watch, running, [typecheck]);
    expect(message.notification).toEqual({
      source: { kind: "monitor" },
      outcome: "failed",
      summary: "CI #812: a job failed",
    });
    const lines = message.text.split("\n");
    expect(lines[0]).toContain(
      "on main at 0123456, which styal is watching for you. It is still running",
    );
    expect(lines[1]).toBe(`  - Typecheck ${watch.url}/job/1`);
    expect(message.text).toContain("The run stays watched");
    expect(
      workflowRunJobsFailedMessage(watch, running, [typecheck, tests]).notification.summary,
    ).toBe("CI #812: 2 jobs failed");
  });

  it("leaves jobs already reported out of the completion wake, and counts them", () => {
    const finished = run({ conclusion: "failure", failedJobs: [typecheck, tests] });
    const lines = workflowRunCompletedMessage(
      { ...watch, failedJobs: ["Typecheck"] },
      finished,
    ).text.split("\n");
    expect(lines.slice(1, 4)).toEqual([
      "Other jobs that did not pass:",
      "  - Test (cancelled)",
      "1 failed job was reported to you while the run was going.",
    ]);
    const allReported = workflowRunCompletedMessage(
      { ...watch, failedJobs: ["Typecheck", "Test"] },
      finished,
    ).text;
    expect(allReported).not.toContain("did not pass:");
    expect(allReported).toContain("2 failed jobs were reported to you while the run was going.");
  });
});
