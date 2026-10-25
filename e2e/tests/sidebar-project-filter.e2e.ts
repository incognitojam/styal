import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { type App, addProject, openApp, sendMessage, startNewThread } from "../support/browser.ts";
import { type Environment, PROJECT_NAME, startEnvironment } from "../support/environment.ts";

describe("filter the sidebar by project", () => {
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

  it("lists only the chosen project's threads and starts new threads in it", async () => {
    const { page } = app;
    const sidebar = page.getByRole("navigation", { name: "Threads" });
    const demoThreads = sidebar.getByRole("button", { name: `Fake Codex thread, ${PROJECT_NAME}` });
    const otherThread = sidebar.getByRole("button", { name: "Fake Codex thread, other-app" });
    const chooseFilter = async (current: string, option: string) => {
      await sidebar.getByRole("combobox", { name: current, exact: true }).click();
      await page.getByRole("option", { name: option }).click();
    };

    await sendMessage(app, "Demo task");
    await addProject(page, environment.createProject("other-app", { git: false }));
    await sendMessage(app, "Other task");
    await demoThreads.waitFor();
    await otherThread.waitFor();

    // Filtered to demo-app while the other project's thread is open.
    await chooseFilter("Filter threads by project", PROJECT_NAME);
    await sidebar
      .getByRole("combobox", { name: `Filter threads by project: ${PROJECT_NAME}` })
      .waitFor();
    await otherThread.waitFor({ state: "detached" });
    await demoThreads.waitFor();

    // The sidebar's New thread follows the filter, not the open thread.
    await startNewThread(app);
    await sendMessage(app, "Second demo task");
    await demoThreads.nth(1).waitFor();
    expect(environment.codexTurns()).toHaveLength(3);

    // Switching straight to another project replaces the filter.
    await chooseFilter(`Filter threads by project: ${PROJECT_NAME}`, "other-app");
    await otherThread.waitFor();
    await demoThreads.first().waitFor({ state: "detached" });

    await chooseFilter("Filter threads by project: other-app", "All projects");
    await sidebar
      .getByRole("combobox", { name: "Filter threads by project", exact: true })
      .waitFor();
    await otherThread.waitFor();
    expect(await demoThreads.count()).toBe(2);
  });
});
