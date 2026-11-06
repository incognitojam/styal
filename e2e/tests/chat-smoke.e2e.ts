// @effect-diagnostics nodeBuiltinImport:off - inspect the isolated provider attachment bytes.
import * as NodeFS from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { sidebarThread, type App, addProject, openApp, sendMessage } from "../support/browser.ts";
import { type Environment, startEnvironment } from "../support/environment.ts";

describe("chat with an agent", () => {
  let environment: Environment;
  let app: App;

  beforeAll(async () => {
    environment = await startEnvironment({
      scenario: {
        turns: [
          {
            match: "Read the attached inventory",
            steps: [{ type: "message", text: "Inventory received." }],
          },
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
    try {
      await app?.close();
    } finally {
      await environment?.stop();
    }
  });

  it("adds a project, starts a thread, and sends follow-ups to the same provider thread", async () => {
    const { page } = app;
    await addProject(page, environment.createProject("notes-app"));
    await sendMessage(app, "Summarize the README", "The README has a single heading.");
    await sendMessage(app, "Thanks, now list the files");

    // The generated title replaces "New thread" in the sidebar and the header.
    await sidebarThread(page, "Fake Codex thread", "notes-app").waitFor();
    await page.getByRole("heading", { name: "Fake Codex thread", level: 2 }).waitFor();
    expect(await page.locator("[data-message-role=user]").count()).toBe(2);

    const turns = environment.codexTurns();
    expect(turns.map((turn) => turn.input.map((item) => item.text ?? "").join("\n"))).toEqual([
      "Summarize the README",
      "Thanks, now list the files",
    ]);
    expect(turns[1]!.threadId).toBe(turns[0]!.threadId);
  });

  it("uploads a generic file and preserves its bytes and history after reload", async () => {
    const { page } = app;
    const contents = "item,count\nsynthetic-widget,7\n";
    await page.locator('input[type="file"]').setInputFiles({
      name: "inventory.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(contents),
    });
    await sendMessage(app, "Read the attached inventory", "Inventory received.");
    const prompt = environment
      .codexTurns()
      .at(-1)!
      .input.map((item) => item.text ?? "")
      .join("\n");
    const path = prompt.match(
      /Attached file "inventory\.csv" is saved at: (.*?)(?: \(text extracted to:|\])/u,
    )?.[1];
    expect(path).toBeDefined();
    expect(NodeFS.readFileSync(path!, "utf8")).toBe(contents);
    const attachment = page
      .locator("[data-message-role=user]")
      .getByRole("button", { name: /^File attachment, inventory\.csv,/u });
    await attachment.waitFor();
    await page.reload();
    await attachment.waitFor();
    await attachment.click();
    await page.getByRole("cell", { name: "synthetic-widget", exact: true }).waitFor();
  });
});
