import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { type App, openApp } from "../support/browser.ts";
import { type Environment, startEnvironment } from "../support/environment.ts";

describe("send a restored rich-text draft", () => {
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

  async function setRichText(enabled: boolean) {
    const { page, composer } = app;
    const conversationUrl = page.url();
    await page.goto(`${environment.origin}/settings/general`);
    const toggle = page.getByRole("switch", { name: "Rich text composer", exact: true });
    if ((await toggle.getAttribute("aria-checked")) !== String(enabled)) await toggle.click();
    await page.goto(conversationUrl);
    await composer.waitFor();
    await page.waitForFunction(
      (expected) =>
        document
          .querySelector("[data-composer-rich-text]")
          ?.getAttribute("data-composer-rich-text") === expected,
      String(enabled),
    );
  }

  it("keeps the line after a quote outside the quote without another edit", async () => {
    const { page, composer } = app;
    await setRichText(false);
    await composer.click();
    await page.keyboard.type("> Quoted line");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("Line after the quote");
    await composer.filter({ hasText: "Line after the quote" }).waitFor();

    // The rich-text editor restores the plain-text draft and shows two separate blocks.
    await setRichText(true);
    await composer.locator("blockquote").filter({ hasText: "Quoted line" }).waitFor();
    await page.getByRole("button", { name: "Submit message" }).click();

    const sent = page.locator("[data-message-role=user]").last();
    await sent.locator("blockquote").filter({ hasText: "Quoted line" }).waitFor();
    expect((await sent.locator("blockquote").innerText()).trim()).toBe("Quoted line");
    await sent.locator("p", { hasText: "Line after the quote" }).waitFor();
    expect(await sent.locator("blockquote", { hasText: "Line after the quote" }).count()).toBe(0);
    await page.getByText(/^Fake Codex reply to: > Quoted line/).waitFor();
    const turns = environment.codexTurns();
    expect(turns).toHaveLength(1);
    expect(turns[0]!.input.map((item) => item.text ?? "").join("")).toContain(
      "> Quoted line\n\nLine after the quote",
    );
  });
});
