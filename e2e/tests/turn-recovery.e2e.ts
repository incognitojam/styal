import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { type App, openApp, sendMessage } from "../support/browser.ts";
import { type Environment, startEnvironment } from "../support/environment.ts";

describe("recover a turn", () => {
  let environment: Environment;
  let app: App;

  beforeAll(async () => {
    environment = await startEnvironment({
      scenario: {
        stepDelayMs: 10,
        turns: [
          {
            match: "Keep working",
            steps: [{ type: "message", text: "Work has started." }, { type: "hold" }],
          },
          {
            match: "Fail this turn",
            steps: [],
            error: "Synthetic provider failure: capacity exhausted.",
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

  it("stops a running turn and accepts another message in the same thread", async () => {
    const { page, composer } = app;
    await composer.click();
    await page.keyboard.type("Keep working");
    await composer.filter({ hasText: "Keep working" }).waitFor();
    await page.getByRole("button", { name: "Submit message", exact: true }).click();
    await page.getByText("Work has started.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Stop generation" }).click();
    await page.getByText("Stopped by user").first().waitFor();
    await page.getByRole("button", { name: "Stop generation" }).waitFor({ state: "hidden" });
    await sendMessage(app, "Continue with a shorter task");
    const turns = environment.codexTurns();
    expect(turns).toHaveLength(2);
    expect(turns[1]!.threadId).toBe(turns[0]!.threadId);
  });

  it("shows the failure reason and accepts a successful retry", async () => {
    const { page, composer } = app;
    await composer.click();
    await page.keyboard.type("Fail this turn");
    await composer.filter({ hasText: "Fail this turn" }).waitFor();
    await page.getByRole("button", { name: "Submit message", exact: true }).click();
    await page
      .getByText("Synthetic provider failure: capacity exhausted.", { exact: true })
      .first()
      .waitFor();
    await page.getByRole("button", { name: "Stop generation" }).waitFor({ state: "hidden" });
    await sendMessage(app, "Try the task again");
    expect(environment.codexTurns()).toHaveLength(4);
  });
});
