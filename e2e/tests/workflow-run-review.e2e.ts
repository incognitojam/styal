import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { type App, openApp, sendMessage, startNewThread } from "../support/browser.ts";
import { type Environment, startEnvironment } from "../support/environment.ts";
import type { FakeGitHubWorkflowRun } from "../support/fake-github-api.ts";

describe("review a watched workflow deployment", () => {
  let environment: Environment;
  let app: App;
  const single: FakeGitHubWorkflowRun = {
    id: 7101,
    name: "Deploy single",
    status: "waiting",
    environments: [
      { id: 21, name: "production" },
      { id: 22, name: "restricted", canApprove: false },
    ],
  };
  const multiple: FakeGitHubWorkflowRun = {
    id: 7102,
    name: "Deploy multiple",
    status: "waiting",
    environments: [
      { id: 31, name: "staging" },
      { id: 32, name: "production" },
    ],
    failedJobs: [{ name: "Deploy staging", conclusion: "failure" }],
  };
  const retry: FakeGitHubWorkflowRun = {
    id: 7103,
    name: "Deploy retry",
    status: "waiting",
    environments: [
      { id: 41, name: "staging" },
      { id: 42, name: "production" },
    ],
    reviewError: { status: 403, message: "Deployment review is temporarily unavailable" },
  };
  const stopped: FakeGitHubWorkflowRun = {
    id: 7104,
    name: "Promote release at 1234567890abcdef1234567890abcdef12345678",
    status: "waiting",
    environments: [{ id: 51, name: "production" }],
  };

  const reviews = (run: FakeGitHubWorkflowRun) =>
    environment
      .gitHubApiRequests()
      .filter(
        (request) =>
          request.method === "POST" &&
          request.path === `/repos/e2e-org/demo-app/actions/runs/${run.id}/pending_deployments`,
      );
  const sidebar = () =>
    app.page.getByRole("navigation", { name: "Threads" }).locator('[aria-current="page"]');

  async function watch(run: FakeGitHubWorkflowRun) {
    await startNewThread(app, "demo-app");
    await sendMessage(app, `Watch ${run.name}`, `Watching ${run.name}.`);
    // A fresh server reads durable watches immediately, without waiting for its two-minute timer.
    await environment.restart();
    await app.page.reload();
    await app.page.getByText("Deployment review", { exact: true }).waitFor();
    await sidebar().getByText("Approval", { exact: true }).waitFor();
  }

  beforeAll(async () => {
    const runs = [single, multiple, retry, stopped];
    environment = await startEnvironment({
      workflowRuns: runs,
      scenario: {
        turns: [
          ...runs.map((run) => ({
            match: `Watch ${run.name}`,
            steps: [
              {
                type: "mcpCall",
                name: "watch_workflow_run",
                arguments: {
                  url: `https://github.com/e2e-org/demo-app/actions/runs/${run.id}`,
                },
              },
              { type: "message", text: `Watching ${run.name}.` },
            ],
          })),
          {
            match: "Workflow run",
            steps: [{ type: "message", text: "Received the workflow result." }],
          },
        ],
      },
    });
    app = await openApp(environment);
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await environment?.stop();
    }
  });

  it("stops the sole watch from its compact review panel while the agent is idle", async () => {
    const { page } = app;
    await watch(stopped);
    await page.getByText("Promote release at 12345678 #7104", { exact: true }).waitFor();
    const label = page.getByLabel(`${stopped.name} #7104`, { exact: true });
    await label.hover();
    await page
      .locator('[data-slot="tooltip-popup"]')
      .filter({ hasText: `${stopped.name} #7104` })
      .waitFor();
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    expect(await stop.count()).toBe(1);
    const turns = environment.codexTurns().length;
    await stop.click();
    await page.getByText("Deployment review", { exact: true }).waitFor({ state: "hidden" });
    await stop.waitFor({ state: "hidden" });
    await sidebar().getByText("Approval", { exact: true }).waitFor({ state: "hidden" });
    expect(environment.codexTurns()).toHaveLength(turns);

    stopped.status = "completed";
    stopped.conclusion = "success";
    stopped.environments = [];
    await environment.restart();
    await page.reload();
    await page.getByText(`Watching ${stopped.name}.`, { exact: true }).waitFor();
    expect(environment.codexTurns()).toHaveLength(turns);
  });

  it("restores the review after a restart, approves one environment directly, and wakes once on completion", async () => {
    // workflow-run-watch
    const { page } = app;
    await watch(single);
    await page
      .getByText("Waiting for your review to deploy to production.", { exact: true })
      .waitFor();
    expect(await page.getByRole("checkbox").count()).toBe(0);
    expect(
      await page.getByRole("link", { name: "Open on GitHub", exact: true }).getAttribute("href"),
    ).toBe(`https://github.com/e2e-org/demo-app/actions/runs/${single.id}`);
    const turnsBeforeReview = environment.codexTurns().length;
    await page.getByRole("textbox", { name: "Review comment" }).fill("  Ship the release  ");
    await page.getByRole("button", { name: "Approve and deploy", exact: true }).click();
    await page.getByText("Deployment review", { exact: true }).waitFor({ state: "hidden" });
    expect(reviews(single).map((request) => request.body)).toEqual([
      {
        environment_ids: [21],
        state: "approved",
        comment: "Ship the release",
      },
    ]);
    await sidebar()
      .getByText(/^Waiting/)
      .waitFor();
    expect(environment.codexTurns()).toHaveLength(turnsBeforeReview);

    single.status = "completed";
    single.conclusion = "success";
    single.environments = [];
    await environment.restart();
    await page.reload();
    await page.getByText("Received the workflow result.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Stop generation" }).waitFor({ state: "hidden" });
    const turns = environment.codexTurns();
    expect(turns).toHaveLength(turnsBeforeReview + 1);
    expect(turns.at(-1)!.input).toEqual([
      {
        type: "text",
        text: expect.stringContaining("finished: success."),
      },
    ]);
    await sidebar()
      .getByText(/^Waiting/)
      .waitFor({ state: "hidden" });
    // The completed watch was removed durably, so another startup cannot wake it again.
    await environment.restart();
    await page.reload();
    await page.getByText("Received the workflow result.", { exact: true }).waitFor();
    expect(environment.codexTurns()).toHaveLength(turns.length);
  });

  it("requires a selection for multiple deployments and rejects only the selected environment", async () => {
    const { page } = app;
    await watch(multiple);
    const staging = page.getByRole("checkbox", { name: "staging", exact: true });
    const production = page.getByRole("checkbox", { name: "production", exact: true });
    expect(await staging.isChecked()).toBe(true);
    expect(await production.isChecked()).toBe(true);
    await staging.uncheck();
    await production.uncheck();
    expect(await page.getByRole("button", { name: "Reject", exact: true }).isDisabled()).toBe(true);
    expect(
      await page.getByRole("button", { name: "Approve and deploy", exact: true }).isDisabled(),
    ).toBe(true);
    expect(reviews(multiple)).toHaveLength(0);

    await staging.check();
    await page
      .getByRole("textbox", { name: "Review comment" })
      .fill("Hold staging for investigation");
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await page.getByText("Deployment review", { exact: true }).waitFor({ state: "hidden" });
    await page.getByText("Received the workflow result.", { exact: true }).waitFor();
    expect(reviews(multiple).map((request) => request.body)).toEqual([
      {
        environment_ids: [31],
        state: "rejected",
        comment: "Hold staging for investigation",
      },
    ]);
    const input = environment
      .codexTurns()
      .at(-1)!
      .input.map((item) => item.text)
      .join("\n");
    expect(input).toContain("finished: failure.");
    expect(input).toContain("Deploy staging");
    await sidebar().getByText("Approval", { exact: true }).waitFor({ state: "hidden" });
  });

  it("shows a GitHub error, preserves the selection and comment, and lets the user retry", async () => {
    const { page } = app;
    await watch(retry);
    const turnsBeforeReview = environment.codexTurns().length;
    const production = page.getByRole("checkbox", { name: "production", exact: true });
    await production.uncheck();
    const comment = page.getByRole("textbox", { name: "Review comment" });
    await comment.fill("Deploy the staging fix");
    const approve = page.getByRole("button", { name: "Approve and deploy", exact: true });
    await approve.click();
    await page.getByText("Could not approve deployment", { exact: true }).waitFor();
    await page.getByText(/Deployment review is temporarily unavailable/).waitFor();
    expect(await comment.inputValue()).toBe("Deploy the staging fix");
    expect(await page.getByRole("checkbox", { name: "staging", exact: true }).isChecked()).toBe(
      true,
    );
    expect(await production.isChecked()).toBe(false);
    await sidebar().getByText("Approval", { exact: true }).waitFor();
    expect(environment.codexTurns()).toHaveLength(turnsBeforeReview);

    delete retry.reviewError;
    await approve.click();
    // Only production remains waiting, so the fresh form no longer needs checkboxes.
    await page
      .getByText("Waiting for your review to deploy to production.", { exact: true })
      .waitFor();
    expect(await page.getByRole("checkbox").count()).toBe(0);
    expect(reviews(retry).map((request) => request.body)).toEqual([
      { environment_ids: [41], state: "approved", comment: "Deploy the staging fix" },
      { environment_ids: [41], state: "approved", comment: "Deploy the staging fix" },
    ]);
    await approve.click();
    await page.getByText("Deployment review", { exact: true }).waitFor({ state: "hidden" });
    expect(reviews(retry).at(-1)!.body).toEqual({
      environment_ids: [42],
      state: "approved",
      comment: "",
    });
    await sidebar().getByText("Approval", { exact: true }).waitFor({ state: "hidden" });
    expect(environment.codexTurns()).toHaveLength(turnsBeforeReview);
  });
});
