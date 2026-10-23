import { type Browser, type Locator, type Page, chromium } from "playwright-core";

import type { Environment } from "./environment.ts";
import { markFailed, onTestFailure } from "./failures.ts";

export interface App {
  readonly browser: Browser;
  readonly page: Page;
  /** The composer's editor. */
  readonly composer: Locator;
  readonly close: () => Promise<void>;
}

/**
 * Opens headless Chromium, pairs it with the environment, and waits for the composer. When a
 * test fails, the page is saved to `test-failure.png` in the environment's directory.
 */
export async function openApp(environment: Environment): Promise<App> {
  let page: Page | undefined;
  const browser = await chromium.launch().catch((error: unknown) => {
    markFailed();
    throw error;
  });
  try {
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
    page = await context.newPage();
    await page.goto(environment.pairingUrl);
    const composer = page.locator("[contenteditable=true]").first();
    await composer.waitFor({ timeout: 60_000 });
    const openedPage = page;
    const removeFailureHandler = onTestFailure(async () => {
      await openedPage.screenshot({ path: `${environment.root}/test-failure.png` });
    });
    return {
      browser,
      page: openedPage,
      composer,
      close: async () => {
        removeFailureHandler();
        await browser.close();
      },
    };
  } catch (error) {
    markFailed();
    await page?.screenshot({ path: `${environment.root}/open-app-failure.png` }).catch(() => {});
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

/**
 * Pairs another environment with the app through Settings → Connections → Add environment,
 * and waits until Connections lists it as connected.
 */
export async function addEnvironment(page: Page, pairingUrl: string): Promise<void> {
  await page.goto(new URL("/settings/connections", page.url()).href);
  await page.getByRole("button", { name: "Add environment" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Environment" });
  // A full pairing URL fills both the host and the pairing code.
  await dialog.getByRole("textbox", { name: "Host" }).fill(pairingUrl);
  await dialog.getByRole("button", { name: "Add environment" }).click();
  await page.getByText(`${new URL(pairingUrl).origin}/ · Connected`).waitFor({ timeout: 60_000 });
}
