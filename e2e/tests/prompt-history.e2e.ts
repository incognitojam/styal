import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { type App, openApp, sendMessage } from "../support/browser.ts";
import { type Environment, startEnvironment } from "../support/environment.ts";

describe("browse normalized prompt history", () => {
  let environment: Environment;
  let app: App;

  beforeAll(async () => {
    environment = await startEnvironment();
    app = await openApp(environment);
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await environment?.stop();
    }
  });

  async function setRichText(enabled: boolean) {
    const { page, composer } = app;
    const conversationUrl = page.url();
    await page.goto(`${environment.origin}/settings/general`);
    const toggle = page.getByRole("switch", { name: "Rich text composer", exact: true });
    if ((await toggle.getAttribute("aria-checked")) !== String(enabled)) await toggle.click();
    await page.goto(conversationUrl);
    await composer.waitFor();
    await page.waitForFunction(
      (expected) =>
        document
          .querySelector("[data-composer-rich-text]")
          ?.getAttribute("data-composer-rich-text") === expected,
      String(enabled),
    );
  }

  it("recalls older prompts, returns to empty, and stops browsing after an edit", async () => {
    const { page, composer } = app;
    await setRichText(false);
    await sendMessage(app, "older prompt");
    await composer.click();
    await page.keyboard.type("- [X] done");
    await page.getByRole("button", { name: "Submit message" }).click();
    await page.getByText("Fake Codex reply to: - [X] done", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Stop generation" }).waitFor({ state: "hidden" });
    await setRichText(true);
    // History comes from the thread timeline, which can finish syncing after the reload.
    await page.getByText("Fake Codex reply to: - [X] done", { exact: true }).waitFor();
    await composer.click();

    await page.keyboard.press("ArrowUp");
    await composer.locator('li[data-checked="true"]').waitFor();
    await page.keyboard.press("ArrowUp");
    await composer.filter({ hasText: "older prompt" }).waitFor();
    await page.keyboard.press("ArrowDown");
    await composer.locator('li[data-checked="true"]').waitFor();
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(
      () => document.querySelector('[data-testid="composer-editor"]')?.textContent?.trim() === "",
    );

    await page.keyboard.press("ArrowUp");
    await composer.locator('li[data-checked="true"]').waitFor();
    await page.keyboard.type(" edited");
    await page.keyboard.press("ArrowDown");
    expect(await composer.innerText()).toContain("done edited");
    expect(environment.codexTurns()).toHaveLength(2);
  });
});
