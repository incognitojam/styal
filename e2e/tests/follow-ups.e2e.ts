import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { type App, openApp, startNewThread } from "../support/browser.ts";
import { type Environment, startEnvironment } from "../support/environment.ts";

describe("dispatch follow-ups", () => {
  let environment: Environment;
  let app: App;

  beforeAll(async () => {
    environment = await startEnvironment({
      scenario: {
        stepDelayMs: 10,
        turns: [
          {
            match: "Wait for instructions",
            steps: [{ type: "message", text: "Waiting for instructions." }, { type: "hold" }],
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

  async function type(text: string) {
    await app.composer.click();
    await app.page.keyboard.type(text);
    await app.composer.filter({ hasText: text }).waitFor();
  }

  for (const behavior of ["Queue", "Steer"] as const) {
    it(`${behavior} is the default and mod+Enter dispatches the opposite action`, async () => {
      const { page } = app;
      const conversationUrl = page.url();
      await page.goto(`${environment.origin}/settings/general`);
      await page.getByRole("combobox", { name: "Follow-up behavior" }).click();
      await page.getByRole("option", { name: behavior, exact: true }).click();
      await page.goto(conversationUrl);
      await app.composer.waitFor();
      await startNewThread(app);
      await type("Wait for instructions");
      await page.getByRole("button", { name: "Submit message", exact: true }).click();
      await page.getByText("Waiting for instructions.", { exact: true }).waitFor();
      const before = environment.codexTurns().length;

      const queueText = `${behavior} queued follow-up`;
      const steerText = `${behavior} steering follow-up`;
      // Queue first, keeping the held turn active so both dispatch paths are observable.
      await type(queueText);
      await page.getByRole("button", { name: `${behavior} message`, exact: true }).waitFor();
      await page.keyboard.press(behavior === "Queue" ? "Enter" : "ControlOrMeta+Enter");
      await page.getByText(queueText, { exact: true }).last().waitFor();
      expect(environment.codexTurns()).toHaveLength(before);
      await type(steerText);
      await page.getByRole("button", { name: `${behavior} message`, exact: true }).waitFor();
      await page.keyboard.press(behavior === "Steer" ? "Enter" : "ControlOrMeta+Enter");
      await page.getByText(`Steered: ${steerText}`, { exact: true }).waitFor();
      await page.getByText(`Fake Codex reply to: ${queueText}`, { exact: true }).waitFor();
      await page.getByRole("button", { name: "Stop generation" }).waitFor({ state: "hidden" });
      expect(environment.codexTurns()).toHaveLength(before + 1);
    });
  }
});
