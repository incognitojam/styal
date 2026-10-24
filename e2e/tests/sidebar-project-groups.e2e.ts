import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { type App, addProject, openApp, sendMessage } from "../support/browser.ts";
import { type Environment, startEnvironment } from "../support/environment.ts";

describe("group sidebar threads by project", () => {
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

  it("shows project headers, and pins and archives projects from a header", async () => {
    const { page } = app;
    const sidebar = page.getByRole("navigation", { name: "Threads" });
    const headers = sidebar.getByTestId("sidebar-project-group-header");
    const headerOrder = () =>
      headers
        .getByRole("button")
        .evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")));
    const header = (name: string) => sidebar.getByRole("button", { name, exact: true });
    const toggleGrouping = async () => {
      await page.goto(new URL("/settings/general", page.url()).href);
      await page.getByRole("switch", { name: "Group threads by project" }).click();
      await page.goBack();
    };
    const headerMenu = async (name: string, item: string) => {
      await header(name).click({ button: "right" });
      await page.getByRole("button", { name: item, exact: true }).click();
    };

    // These checks need no checkpoints, so the second project is a plain folder.
    await addProject(page, environment.createProject("second-app", { git: false }));
    await sendMessage(app, "Second task");
    // sidebar-project-thread-groups: grouping is off by default.
    expect(await headers.count()).toBe(0);

    await toggleGrouping();

    // Headers follow each project's newest thread, and cards under them drop the project name.
    await header("second-app").waitFor();
    expect(await headerOrder()).toEqual(["second-app", "demo-app"]);
    // The empty thread the server starts with in its bootstrap project.
    const demoThread = sidebar.getByRole("button", { name: "New thread, demo-app" });
    expect(await demoThread.innerText()).not.toContain("demo-app");

    // Pinned projects lead the list and show a pin icon.
    await headerMenu("demo-app", "Pin project");
    await header("demo-app").getByRole("img", { name: "Pinned" }).waitFor();
    expect(await headerOrder()).toEqual(["demo-app", "second-app"]);

    // Archiving hides the project and its threads; the toast's Undo brings them back.
    await headerMenu("second-app", "Archive project");
    const toast = page.getByRole("dialog", { name: "Archived second-app" });
    await toast.waitFor();
    await header("second-app").waitFor({ state: "detached" });
    await sidebar.getByRole("button", { name: "Fake Codex thread, second-app" }).waitFor({
      state: "detached",
    });
    await toast.getByRole("button", { name: "Undo" }).click();
    await header("second-app").waitFor();
    expect(await headerOrder()).toEqual(["demo-app", "second-app"]);

    // Turning grouping off restores the flat list.
    await toggleGrouping();
    await demoThread.filter({ hasText: "demo-app" }).waitFor();
    expect(await headers.count()).toBe(0);
  });
});
