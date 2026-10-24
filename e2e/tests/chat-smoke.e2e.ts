import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { type App, addProject, openApp, sendMessage } from "../support/browser.ts";
import { type Environment, startEnvironment } from "../support/environment.ts";

describe("chat with an agent", () => {
  let environment: Environment;
  let app: App;

  beforeAll(async () => {
    environment = await startEnvironment({
      scenario: {
        turns: [
          {
            match: "Summarize the README",
            steps: [
              { type: "reasoning", text: "Reading the README." },
              { type: "message", text: "The README has a single heading." },
            ],
          },
        ],
      },
    });
    app = await openApp(environment);
  });

  afterAll(async () => {
    await app?.close();
    await environment?.stop();
  });

  it("adds a project, starts a thread, and sends follow-ups to the same provider thread", async () => {
    const { page } = app;
    await addProject(page, environment.createProject("notes-app"));
    await sendMessage(app, "Summarize the README", "The README has a single heading.");
    await sendMessage(app, "Thanks, now list the files");

    // The generated title replaces "New thread" in the sidebar and the header.
    const sidebar = page.getByRole("navigation", { name: "Threads" });
    await sidebar.getByRole("button", { name: "Fake Codex thread, notes-app" }).waitFor();
    await page.getByRole("heading", { name: "Fake Codex thread", level: 2 }).waitFor();
    expect(await page.locator("[data-message-role=user]").count()).toBe(2);

    const turns = environment.codexTurns();
    expect(turns.map((turn) => turn.input.map((item) => item.text ?? "").join("\n"))).toEqual([
      "Summarize the README",
      "Thanks, now list the files",
    ]);
    expect(turns[1]!.threadId).toBe(turns[0]!.threadId);
  });
});
