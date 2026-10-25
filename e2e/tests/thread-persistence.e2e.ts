import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { type App, openApp, sendMessage } from "../support/browser.ts";
import { type Environment, startEnvironment } from "../support/environment.ts";

describe("persist a conversation", () => {
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

  it("restores the selected thread, history and unsent draft after reload", async () => {
    const { page, composer } = app;
    await sendMessage(app, "Remember this conversation");
    const threadUrl = page.url();
    await composer.click();
    await page.keyboard.type("An unsent follow-up");
    await composer.filter({ hasText: "An unsent follow-up" }).waitFor();
    await page.reload();
    await composer.filter({ hasText: "An unsent follow-up" }).waitFor();
    expect(page.url()).toBe(threadUrl);
    await page
      .locator("[data-message-role=user]")
      .filter({ hasText: "Remember this conversation" })
      .waitFor();
    await page
      .getByText("Fake Codex reply to: Remember this conversation", { exact: true })
      .waitFor();
    expect(environment.codexTurns()).toHaveLength(1);
  });

  it("reconnects after a server restart and continues the intact thread", async () => {
    const { page, composer } = app;
    const threadUrl = page.url();
    await environment.restart();
    // Sending through the existing page proves its socket has reconnected without a reload.
    await composer.filter({ hasText: "An unsent follow-up" }).waitFor();
    await page.getByRole("button", { name: "Submit message", exact: true }).click();
    await page
      .getByText("Fake Codex reply to: An unsent follow-up", { exact: true })
      .waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: "Stop generation" }).waitFor({ state: "hidden" });
    expect(page.url()).toBe(threadUrl);
    expect(await page.locator("[data-message-role=user]").count()).toBe(2);
    await page
      .getByText("Fake Codex reply to: Remember this conversation", { exact: true })
      .waitFor();
    const turns = environment.codexTurns();
    expect(turns).toHaveLength(2);
    expect(turns[1]!.threadId).toBe(turns[0]!.threadId);
  });
});
