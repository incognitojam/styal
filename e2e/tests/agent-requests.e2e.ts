import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { type App, openApp, startNewThread } from "../support/browser.ts";
import { type Environment, startEnvironment } from "../support/environment.ts";

describe("respond to the agent", () => {
  let environment: Environment;
  let app: App;

  beforeAll(async () => {
    environment = await startEnvironment({
      scenario: {
        stepDelayMs: 10,
        turns: [
          {
            match: "Run a command",
            steps: [
              { type: "approval", command: "echo synthetic-command" },
              { type: "message", text: "Approved command finished." },
            ],
          },
          {
            match: "Ask about the task",
            steps: [
              {
                type: "question",
                questions: [
                  {
                    id: "store",
                    header: "Storage",
                    question: "Where should the cache live?",
                    options: [
                      { label: "Memory", description: "Keep it in memory." },
                      { label: "Disk", description: "Save it on disk." },
                    ],
                  },
                  {
                    id: "note",
                    header: "Details",
                    question: "What else should I know?",
                    options: [],
                  },
                ],
              },
              { type: "message", text: "Received: {{answer:store}}; {{answer:note}}" },
            ],
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

  async function submit(text: string) {
    await app.composer.click();
    await app.page.keyboard.type(text);
    await app.composer.filter({ hasText: text }).waitFor();
    await app.page.getByRole("button", { name: "Submit message", exact: true }).click();
  }

  for (const approve of [true, false]) {
    it(`${approve ? "approves" : "declines"} a command in Supervised mode`, async () => {
      const { page } = app;
      await startNewThread(app);
      await page.getByRole("combobox", { name: "Runtime mode" }).click();
      await page.getByRole("option", { name: /Supervised/ }).click();
      await submit("Run a command");
      await page.getByRole("group", { name: "Command approval", exact: true }).waitFor();
      await page
        .getByLabel("Command", { exact: true })
        .filter({ hasText: "echo synthetic-command" })
        .waitFor();
      await page
        .getByRole("button", { name: approve ? "Approve" : "Decline", exact: true })
        .click();
      await page
        .getByText(approve ? "Approved command finished." : "Command denied by user.", {
          exact: true,
        })
        .waitFor();
      await page.getByRole("button", { name: "Stop generation" }).waitFor({ state: "hidden" });
      expect(await page.getByText("Approved command finished.", { exact: true }).count()).toBe(
        approve ? 1 : 0,
      );
      await page
        .getByRole("group", { name: "Command approval", exact: true })
        .waitFor({ state: "hidden" });
    });
  }

  it("sends single-choice and free-text answers to the provider and records them once", async () => {
    const { page, composer } = app;
    await startNewThread(app);
    await submit("Ask about the task");
    await page.getByRole("button", { name: /Disk Save it on disk/ }).click();
    await page.getByText("What else should I know?", { exact: true }).last().waitFor();
    await composer.click();
    await page.keyboard.type("Keep the cache local");
    await composer.filter({ hasText: "Keep the cache local" }).waitFor();
    await page.getByRole("button", { name: /^Submit(?: answers)?$/ }).click();
    await page.getByText("Received: Disk; Keep the cache local", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Stop generation" }).waitFor({ state: "hidden" });
    const request = page.locator('[data-v2-item-type="user_input_request"]');
    expect(await request.count()).toBe(1);
    if ((await request.getAttribute("aria-expanded")) !== "true") await request.click();
    await request.getByText("Disk", { exact: true }).waitFor();
    await request.getByText("Keep the cache local", { exact: true }).waitFor();
    expect(await request.getByText("Keep the cache local", { exact: true }).count()).toBe(1);
    expect(
      await page.getByText("Received: Disk; Keep the cache local", { exact: true }).count(),
    ).toBe(1);
  });
});
