import { type Browser, type Locator, type Page, chromium } from "playwright-core";

import type { Environment } from "./environment.ts";

export interface App {
  readonly browser: Browser;
  readonly page: Page;
  /** The composer's editor. */
  readonly composer: Locator;
  readonly close: () => Promise<void>;
}

/** Opens headless Chromium, pairs it with the environment, and waits for the composer. */
export async function openApp(environment: Environment): Promise<App> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  // A returning user: the first-run wizard is already done. The workspace holds only the
  // bootstrap project, which would otherwise count as a first run.
  await context.addInitScript(() => {
    if (window.localStorage.getItem("styal:client-settings:v1") === null) {
      window.localStorage.setItem(
        "styal:client-settings:v1",
        JSON.stringify({ onboardingCompletedAt: "2026-01-01T00:00:00.000Z" }),
      );
    }
  });
  const page = await context.newPage();
  try {
    await page.goto(environment.pairingUrl);
    const composer = page.locator("[contenteditable=true]").first();
    await composer.waitFor({ timeout: 60_000 });
    return { browser, page, composer, close: () => browser.close() };
  } catch (error) {
    await page.screenshot({ path: `${environment.root}/open-app-failure.png` }).catch(() => {});
    await browser.close();
    throw error;
  }
}

/**
 * Runs a command palette item. Types `query`, then presses Enter only if the highlighted
 * item contains `expected`, so a search that ranks something else first fails the test
 * instead of running the wrong command. Pass `open: false` to type into a palette view
 * that is already showing, such as a picker the previous item pushed.
 */
export async function runPaletteItem(
  page: Page,
  query: string,
  expected: string,
  options: { readonly open?: boolean } = {},
): Promise<void> {
  const palette = page.getByRole("dialog");
  if (options.open !== false) {
    await page.keyboard.press("ControlOrMeta+k");
    await palette.waitFor();
  }
  await page.keyboard.type(query);
  const highlighted = palette.locator("[data-highlighted]").filter({ hasText: expected });
  await highlighted.first().waitFor({ timeout: 30_000 });
  await page.keyboard.press("Enter");
}
