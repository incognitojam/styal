import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { type App, addProject, openApp, sendMessage, startNewThread } from "../support/browser.ts";
import { type Environment, PROJECT_NAME, startEnvironment } from "../support/environment.ts";

/** Waits until the chat shows `shown` and no longer shows `hidden`. */
async function expectConversation(page: Page, shown: string, hidden: string): Promise<void> {
  const userMessages = page.locator("[data-message-role=user]");
  await userMessages.filter({ hasText: shown }).first().waitFor();
  await userMessages.filter({ hasText: hidden }).first().waitFor({ state: "detached" });
}

describe("keep unsent drafts", () => {
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

  it("keeps each thread's draft across switches and gives a new thread its own", async () => {
    const { page, composer } = app;
    const sidebar = page.getByRole("navigation", { name: "Threads" });
    const demoThread = sidebar.getByRole("button", { name: `Fake Codex thread, ${PROJECT_NAME}` });
    const otherThread = sidebar.getByRole("button", { name: "Fake Codex thread, other-app" });
    const composerText = async () => (await composer.innerText()).trim();

    await sendMessage(app, "Demo task");
    await addProject(page, environment.createProject("other-app", { git: false }));
    await sendMessage(app, "Other task");

    await composer.click();
    await page.keyboard.type("Unsent note for other-app");
    await composer.filter({ hasText: "Unsent note for other-app" }).waitFor();

    // Another thread shows its own, empty composer.
    await demoThread.click();
    await expectConversation(page, "Demo task", "Other task");
    expect(await composerText()).toBe("");

    await otherThread.click();
    await expectConversation(page, "Other task", "Demo task");
    await composer.filter({ hasText: "Unsent note for other-app" }).waitFor();

    // A new thread starts empty, and its draft does not leak into the thread it came from.
    await startNewThread(app, "other-app");
    expect(await composerText()).toBe("");
    await composer.click();
    await page.keyboard.type("Idea for a new thread");
    await composer.filter({ hasText: "Idea for a new thread" }).waitFor();
    const draftUrl = page.url();

    await otherThread.click();
    await expectConversation(page, "Other task", "Demo task");
    await composer.filter({ hasText: "Unsent note for other-app" }).waitFor();
    expect(await composerText()).not.toContain("Idea for a new thread");

    await page.goBack();
    await page.waitForURL(draftUrl);
    await composer.filter({ hasText: "Idea for a new thread" }).waitFor();
    expect(await composerText()).toBe("Idea for a new thread");
    expect(environment.codexTurns()).toHaveLength(2);
  });
});
