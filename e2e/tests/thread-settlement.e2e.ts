import type { Locator } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { type App, addProject, openApp, sendMessage } from "../support/browser.ts";
import { type Environment, startEnvironment } from "../support/environment.ts";

/** Whether `row` sits above `header` in the sidebar, which puts it outside the shelf. */
async function isAbove(row: Locator, header: Locator): Promise<boolean> {
  const [rowBox, headerBox] = await Promise.all([row.boundingBox(), header.boundingBox()]);
  return rowBox!.y < headerBox!.y;
}

describe("settle a thread", () => {
  let environment: Environment;
  let app: App;

  beforeAll(async () => {
    environment = await startEnvironment();
    app = await openApp(environment);
  });

  afterAll(async () => {
    await app?.close();
    await environment?.stop();
  });

  it("moves the thread to the settled shelf and back", async () => {
    const { page } = app;
    const sidebar = page.getByRole("navigation", { name: "Threads" });
    const settledHeader = sidebar.getByTestId("sidebar-settled-header");
    const settledThread = sidebar.getByRole("button", { name: "Fake Codex thread, second-app" });
    // The empty thread the server starts with in its bootstrap project.
    const otherThread = sidebar.getByRole("button", { name: "New thread, demo-app" });

    // These checks need no checkpoints, so the second project is a plain folder.
    await addProject(page, environment.createProject("second-app", { git: false }));
    await sendMessage(app, "Second task");

    await settledThread.hover();
    await settledThread.getByRole("button", { name: "Settle thread" }).click();
    // Settling the open thread moves on to the next one and leaves the shelf collapsed.
    await page.getByRole("button", { name: "New thread in demo-app" }).waitFor();
    await settledHeader.getByRole("button", { name: "Settled (1)" }).waitFor();
    await settledThread.waitFor({ state: "hidden" });

    // Settlement is server state, so it survives a reload.
    await page.reload();
    await settledHeader.getByRole("button", { name: "Settled (1)" }).click();
    await settledHeader.getByRole("button", { name: "Settled", exact: true }).waitFor();
    await settledThread.getByRole("button", { name: "Un-settle thread" }).waitFor();
    expect(await isAbove(settledThread, settledHeader)).toBe(false);

    // settled-shelf-auto-collapse: opening a settled thread keeps the shelf open, and
    // opening a thread outside it closes the shelf.
    await settledThread.click();
    await page.getByRole("button", { name: "New thread in second-app" }).waitFor();
    await settledHeader.getByRole("button", { name: "Settled", exact: true }).waitFor();
    await otherThread.click();
    await settledHeader.getByRole("button", { name: "Settled (1)" }).waitFor();
    await settledThread.waitFor({ state: "hidden" });

    // Un-settling keeps the shelf open and returns the thread to the active list.
    await settledHeader.getByRole("button", { name: "Settled (1)" }).click();
    await settledThread.hover();
    await settledThread.getByRole("button", { name: "Un-settle thread" }).click();
    await settledThread.getByRole("button", { name: "Settle thread" }).waitFor();
    await settledHeader.getByRole("button", { name: "Settled", exact: true }).waitFor();
    expect(await isAbove(settledThread, settledHeader)).toBe(true);
  });
});
