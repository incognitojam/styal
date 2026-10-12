import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { type App, openApp, runPaletteItem } from "../support/browser.ts";
import { type Environment, startEnvironment } from "../support/environment.ts";

const ISSUE = {
  number: 42,
  title: "Login button does nothing",
  state: "OPEN",
  url: "https://github.com/e2e-org/demo-app/issues/42",
  body: "Clicking Log in on Safari does nothing.",
  author: { login: "reporter" },
  comments: [{ author: { login: "triager" }, body: "Seen on Safari 17.2 as well." }],
} as const;
const CHIP_LABEL = `Issue, #${ISSUE.number} ${ISSUE.title}`;

describe("start a thread from a GitHub issue", () => {
  let environment: Environment;
  let app: App;

  beforeAll(async () => {
    environment = await startEnvironment({
      issues: [ISSUE],
      scenario: {
        turns: [{ steps: [{ type: "message", text: "Looked at the attached issue." }] }],
      },
    });
    app = await openApp(environment);
  });

  afterAll(async () => {
    await app?.close();
    await environment?.stop();
  });

  it("attaches the issue as a composer chip and sends its contents to the provider", async () => {
    const { page, composer } = app;
    await runPaletteItem(page, "github issue", "New thread from GitHub issue");
    await page.getByRole("dialog").getByText("Open issues").waitFor();
    await runPaletteItem(page, String(ISSUE.number), ISSUE.title, { open: false });

    await composer.getByLabel(CHIP_LABEL).waitFor();

    await composer.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("Please fix this.");
    await page.locator('form button[type="submit"]').last().click();

    await page.getByText("Looked at the attached issue.").waitFor();
    const userMessage = page.locator("[data-message-role=user]").last();
    await userMessage.getByLabel(CHIP_LABEL).waitFor();

    const turns = environment.codexTurns();
    expect(turns).toHaveLength(1);
    const prompt = turns[0]!.input.map((item) => item.text ?? "").join("\n");
    expect(prompt).toContain("Please fix this.");
    expect(prompt).toContain(`issue: #${ISSUE.number} ${ISSUE.title}`);
    expect(prompt).toContain(ISSUE.body);
    expect(prompt).toContain(`comment by triager:\n  ${ISSUE.comments[0].body}`);
  });
});
