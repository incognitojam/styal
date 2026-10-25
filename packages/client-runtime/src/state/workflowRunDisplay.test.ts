import type { ThreadWorkflowRunWatch } from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { describe, expect, it } from "vite-plus/test";

import { presentPendingBackgroundWork } from "./threadExecution.ts";
import {
  formatWorkflowRunDisplayName,
  workflowRunReviewCoversBackgroundWork,
} from "./workflowRunDisplay.ts";

const sha = "cd39a3ce97c2411b70ffda8d6e89dd9826555b3b";
const name = `Promote intake/2026-10-25-batch20 at ${sha} #260`;
const compactName = "Promote intake/2026-10-25-batch20 at cd39a3ce #260";
const run: ThreadWorkflowRunWatch = {
  host: "github.com",
  repository: "example/demo-app",
  runId: 7101,
  url: "https://github.com/example/demo-app/actions/runs/7101",
  name,
  startedAt: "2026-10-25T10:00:00.000Z",
  review: { environments: [{ id: 21, name: "production" }] },
};

function tasksFor(watched: ThreadWorkflowRunWatch) {
  return derivePendingBackgroundWork({
    latestRun: null,
    providerThreads: [],
    turnItems: [],
    workflowRuns: [watched],
  });
}

describe("workflow run display", () => {
  it("shortens full SHA tokens while keeping the workflow, branch and run number", () => {
    expect(formatWorkflowRunDisplayName(name)).toBe(compactName);
    expect(formatWorkflowRunDisplayName(`${sha.toUpperCase()} / ${sha}`)).toBe(
      "CD39A3CE / cd39a3ce",
    );
  });

  it.each(["CI #812", "Deploy cd39a3ce #260", `Deploy ${sha}f`, `Deploy x${sha}`, sha.slice(1)])(
    "preserves non-SHA tokens in %s",
    (title) => {
      expect(formatWorkflowRunDisplayName(title)).toBe(title);
    },
  );

  it("uses compact monitor labels and keeps full details and watch identity", () => {
    const tasks = tasksFor(run);
    const presentation = presentPendingBackgroundWork(tasks);
    expect(presentation?.title).toBe(`Watching ${compactName}`);
    expect(presentation?.items[0]).toMatchObject({
      taskId: tasks[0]?.taskId,
      label: `Watching ${compactName}`,
      fullLabel: `Watching ${name}`,
    });
    expect(tasks[0]?.description).toBe(`Watching ${name}`);
    expect(run.name).toBe(name);
    expect(run.url).toBe("https://github.com/example/demo-app/actions/runs/7101");
  });

  it("compacts workflow labels in a mixed roster without rewriting other task descriptions", () => {
    const presentation = presentPendingBackgroundWork([
      ...tasksFor(run),
      { taskId: "command", kind: "command", description: `git show ${sha}` },
      { taskId: "other-monitor", kind: "monitor", description: `Watching ${sha}` },
    ]);
    expect(presentation?.title).toBe("Waiting on 1 command and 2 monitors");
    expect(presentation?.items.map((item) => item.label)).toEqual([
      `git show ${sha}`,
      `Watching ${compactName}`,
      `Watching ${sha}`,
    ]);
  });
});

describe("workflow review background-work grouping", () => {
  it("groups a sole watch only while its deployment review is present", () => {
    const tasks = tasksFor(run);
    expect(workflowRunReviewCoversBackgroundWork(tasks, [run])).toBe(true);
    expect(workflowRunReviewCoversBackgroundWork(tasks, [{ ...run, review: undefined }])).toBe(
      false,
    );
    expect(workflowRunReviewCoversBackgroundWork(tasks, [])).toBe(false);
    expect(workflowRunReviewCoversBackgroundWork([], [run])).toBe(false);
    expect(workflowRunReviewCoversBackgroundWork(tasks, [run, { ...run, runId: 7102 }])).toBe(
      false,
    );
  });

  it("compares canonical watch identities instead of display names", () => {
    const tasks = tasksFor(run);
    expect(
      workflowRunReviewCoversBackgroundWork(tasks, [{ ...run, name: "Renamed deployment" }]),
    ).toBe(true);
    expect(
      workflowRunReviewCoversBackgroundWork(tasks, [
        { ...run, host: "GITHUB.COM", repository: "EXAMPLE/DEMO-APP" },
      ]),
    ).toBe(true);
    for (const changed of [
      { ...run, host: "git.example.test" },
      { ...run, repository: "example/another-app" },
      { ...run, runId: 7102 },
    ]) {
      expect(workflowRunReviewCoversBackgroundWork(tasks, [changed])).toBe(false);
    }
  });

  it("keeps a mixed roster and other task kinds visible", () => {
    const tasks = tasksFor(run);
    expect(
      workflowRunReviewCoversBackgroundWork(
        [...tasks, { taskId: "command", kind: "command", description: "npm test" }],
        [run],
      ),
    ).toBe(false);
    expect(
      workflowRunReviewCoversBackgroundWork(
        tasks.map((task) => ({ ...task, kind: "command" })),
        [run],
      ),
    ).toBe(false);
  });

  it("keeps multiple watched workflows and an unrelated sole monitor separate", () => {
    const other = { ...run, runId: 7102 };
    expect(
      workflowRunReviewCoversBackgroundWork([...tasksFor(run), ...tasksFor(other)], [run, other]),
    ).toBe(false);
    expect(workflowRunReviewCoversBackgroundWork(tasksFor(other), [run])).toBe(false);
  });
});
