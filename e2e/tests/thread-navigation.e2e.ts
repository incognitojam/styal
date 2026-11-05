import { afterAll, beforeAll, describe, it } from "vite-plus/test";

import {
  sidebarThread,
  type App,
  addProject,
  expectConversation,
  openApp,
  sendMessage,
} from "../support/browser.ts";
import { type Environment, startEnvironment } from "../support/environment.ts";

describe("move between threads", () => {
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

  it("shows the conversation of the thread opened from the sidebar or next unread", async () => {
    const { page } = app;
    const sidebar = page.getByRole("navigation", { name: "Threads" });
    // Each project's thread gets the same generated title, so the project tells them apart.
    const alphaThread = sidebarThread(page, "Fake Codex thread", "alpha-app");
    const betaThread = sidebarThread(page, "Fake Codex thread", "beta-app");

    await addProject(page, environment.createProject("alpha-app", { git: false }));
    await sendMessage(app, "Alpha task");
    await addProject(page, environment.createProject("beta-app", { git: false }));
    await sendMessage(app, "Beta task");
    await expectConversation(page, "Beta task", "Alpha task");

    // Each switch replaces the conversation, not just the URL.
    for (let round = 0; round < 2; round += 1) {
      await alphaThread.click();
      await expectConversation(page, "Alpha task", "Beta task");
      await betaThread.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Mark unread", exact: true }).click();
      await sidebar
        .getByRole("button", { name: "Fake Codex thread, Done, beta-app", exact: true })
        .waitFor();
      await betaThread.click();
      await expectConversation(page, "Beta task", "Alpha task");
    }

    // Next unread opens the thread marked unread from another thread.
    await alphaThread.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Mark unread", exact: true }).click();
    await sidebar.getByText("Done", { exact: true }).waitFor();
    await page.keyboard.press("ControlOrMeta+Shift+U");
    await expectConversation(page, "Alpha task", "Beta task");
  });
});
