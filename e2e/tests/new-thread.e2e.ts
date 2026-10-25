import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { type App, holdRequests, openApp, sendMessage } from "../support/browser.ts";
import { type Environment, PROJECT_NAME, startEnvironment } from "../support/environment.ts";

describe("start a new thread", () => {
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

  it("sends what you type right after New thread to the new thread", async () => {
    const { page, composer } = app;
    const userMessages = page.locator("[data-message-role=user]");
    await sendMessage(app, "First task");
    await page.waitForURL((url) => !url.pathname.startsWith("/draft/"));
    const firstThreadUrl = page.url();

    // Reopen the app on the thread as on a slow connection: any code the draft route loads on
    // demand is held back, so a draft that waited for it would not render.
    const releaseDraftRoute = await holdRequests(page, /\/_chat\.draft\._draftId-[^/]*\.js$/);
    await page.reload();
    await userMessages.filter({ hasText: "First task" }).waitFor();
    await page.getByRole("button", { name: `New thread in ${PROJECT_NAME}`, exact: true }).click();
    await page.waitForURL(/\/draft\/[^/]+$/);

    await composer.click();
    await page.keyboard.type("Second task");
    await page.keyboard.press("Enter");
    await userMessages.filter({ hasText: "Second task" }).waitFor();
    expect(await userMessages.filter({ hasText: "First task" }).count()).toBe(0);
    releaseDraftRoute();

    await page.getByText("Fake Codex reply to: Second task").waitFor();
    await page.waitForURL(
      (url) => url.href !== firstThreadUrl && !url.pathname.startsWith("/draft/"),
    );
    const turns = environment.codexTurns();
    expect(turns).toHaveLength(2);
    expect(turns[1]!.threadId).not.toBe(turns[0]!.threadId);
  });
});
