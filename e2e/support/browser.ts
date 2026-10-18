// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - plain Node e2e harness.
import * as NodeFS from "node:fs";
import {
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  chromium,
} from "playwright-core";

import type { Environment } from "./environment.ts";
import { markFailed, onTestFailure } from "./failures.ts";

const allowedOrigins = new WeakMap<BrowserContext, Set<string>>();

/** Explicitly registers another environment before the browser connects to it. */
export function allowOrigin(page: Page, origin: string): void {
  const origins = allowedOrigins.get(page.context());
  if (!origins) throw new Error("This page has no e2e network guard.");
  origins.add(new URL(origin).origin);
}

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
  const log: string[] = [];
  const blocked: string[] = [];
  const record = (kind: string, message: string) => {
    log.push(`${kind}: ${message.slice(0, 2_000)}`);
    if (log.length > 200) log.shift();
  };
  const saveLog = () => {
    NodeFS.writeFileSync(`${environment.root}/browser.log`, log.join("\n"));
    NodeFS.writeFileSync(
      `${environment.root}/blocked-requests.json`,
      JSON.stringify(blocked, null, 2),
    );
  };
  const browser = await chromium.launch().catch((error: unknown) => {
    markFailed();
    record("launch", String(error));
    saveLog();
    throw error;
  });
  const removeFailureHandler = onTestFailure(async () => {
    saveLog();
    await page?.screenshot({ path: `${environment.root}/test-failure.png` });
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      serviceWorkers: "block",
    });
    const origins = new Set([environment.origin]);
    allowedOrigins.set(context, origins);
    const permitted = (url: string) => {
      const parsed = new URL(url);
      if (parsed.protocol === "ws:") parsed.protocol = "http:";
      if (parsed.protocol === "wss:") parsed.protocol = "https:";
      return origins.has(parsed.origin);
    };
    const block = (request: string) => {
      blocked.push(request);
      record("blocked", request);
    };
    // Also audit redirects, which Playwright does not send through route handlers again.
    context.on("request", (request) => {
      if (/^https?:/.test(request.url()) && !permitted(request.url())) {
        block(`${request.method()} ${request.url()}`);
      }
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (permitted(request.url())) return route.continue();
      await route.abort("blockedbyclient");
    });
    await context.routeWebSocket(/.*/, (socket) => {
      if (permitted(socket.url())) {
        socket.connectToServer();
      } else {
        block(`WEBSOCKET ${socket.url()}`);
        void socket.close();
      }
    });
    context.on("page", (openedPage) => {
      openedPage.on("console", (message) => record(`console.${message.type()}`, message.text()));
      openedPage.on("pageerror", (error) => record("pageerror", error.stack ?? error.message));
      openedPage.on("requestfailed", (request) =>
        record(
          "requestfailed",
          `${request.method()} ${request.url()} ${request.failure()?.errorText}`,
        ),
      );
    });
    // A returning user: the first-run wizard is already done. The workspace holds only the
    // bootstrap project, which would otherwise count as a first run.
    await context.addInitScript(() => {
      if (window.localStorage.getItem("styal:client-settings:v1") === null) {
        window.localStorage.setItem(
          "styal:client-settings:v1",
          JSON.stringify({
            onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
            claudeStatusAlertsEnabled: false,
            openaiStatusAlertsEnabled: false,
            githubStatusAlertsEnabled: false,
          }),
        );
      }
    });
    page = await context.newPage();
    await page.goto(environment.pairingUrl);
    const composer = page.locator("[contenteditable=true]").first();
    await composer.waitFor({ timeout: 60_000 });
    const openedPage = page;
    return {
      browser,
      page: openedPage,
      composer,
      close: async () => {
        try {
          await browser.close();
          if (blocked.length > 0) {
            throw new Error(
              `Browser requests outside registered e2e origins:\n${blocked.join("\n")}`,
            );
          }
        } catch (error) {
          markFailed();
          record("close", String(error));
          throw error;
        } finally {
          removeFailureHandler();
          // The server's later cleanup can still fail and keep this directory.
          saveLog();
        }
      },
    };
  } catch (error) {
    markFailed();
    record("openApp", String(error));
    await page?.screenshot({ path: `${environment.root}/open-app-failure.png` }).catch(() => {});
    await browser.close().catch((closeError: unknown) => record("close", String(closeError)));
    removeFailureHandler();
    saveLog();
    throw error;
  }
}

/**
 * The palette focuses a newly shown input one frame after it mounts, so keys typed before that
 * go to the previously focused element.
 */
async function waitForPaletteInputFocus(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const active = document.activeElement;
    return (
      active instanceof HTMLInputElement &&
      active.closest("[role=dialog]") !== null &&
      !active.hasAttribute("data-e2e-left-palette-input")
    );
  });
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
  await waitForPaletteInputFocus(page);
  await page.keyboard.type(query);
  const highlighted = palette.locator("[data-highlighted]").filter({ hasText: expected });
  await highlighted.first().waitFor({ timeout: 30_000 });
  // Marks this input so a following wait finds the input the item shows next.
  await page.evaluate(() =>
    document.activeElement?.setAttribute("data-e2e-left-palette-input", ""),
  );
  await page.keyboard.press("Enter");
}

/**
 * Pairs another environment with the app through Settings → Connections → Add environment,
 * and waits until Connections lists it as connected.
 */
export async function addEnvironment(page: Page, pairingUrl: string): Promise<void> {
  allowOrigin(page, new URL(pairingUrl).origin);
  await page.goto(new URL("/settings/connections", page.url()).href);
  await page.getByRole("button", { name: "Add environment" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Environment" });
  // A full pairing URL fills both the host and the pairing code.
  await dialog.getByRole("textbox", { name: "Host" }).fill(pairingUrl);
  await dialog.getByRole("button", { name: "Add environment" }).click();
  await page.getByText(`${new URL(pairingUrl).origin}/ · Connected`).waitFor({ timeout: 60_000 });
}

/** Opens a project's draft and waits for its composer to replace the previous thread's. */
export async function startNewThread(app: App, projectName: string): Promise<void> {
  const { page, composer } = app;
  const previousUrl = page.url();
  const previousEditor = await composer.elementHandle();
  await page.getByRole("button", { name: `New thread in ${projectName}`, exact: true }).click();
  await page.waitForURL(/\/draft\/[^/]+$/);
  // The URL can change while the draft route is still loading and the old editor is actionable.
  // An already-open empty draft can be reused without replacing its editor.
  if (page.url() !== previousUrl && previousEditor) {
    await page.waitForFunction((editor) => !editor.isConnected, previousEditor);
  }
  await composer.waitFor();
  await previousEditor?.dispose();
}

/**
 * Sends `text` from the composer and waits for `reply`, which defaults to fake-codex's echo,
 * and then for the turn to finish.
 */
export async function sendMessage(
  app: App,
  text: string,
  reply = `Fake Codex reply to: ${text}`,
): Promise<void> {
  const { page, composer } = app;
  await composer.click();
  await page.keyboard.type(text);
  await composer.filter({ hasText: text }).waitFor();
  await page.getByRole("button", { name: "Submit message" }).click();
  await page.locator("[data-message-role=user]").filter({ hasText: text }).last().waitFor();
  await page.getByText(reply).last().waitFor();
  await page.getByRole("button", { name: "Stop generation" }).waitFor({ state: "hidden" });
}

/**
 * Adds the folder at `path` as a project through the command palette, and waits for the new
 * thread draft in it.
 */
export async function addProject(page: Page, path: string): Promise<void> {
  await runPaletteItem(page, "add project", "Add project");
  await waitForPaletteInputFocus(page);
  // Typing "/" switches the palette to directory browsing, which mounts a new input that takes
  // focus a frame later, so typing the path key by key can drop keys. Fill it in one input event.
  await page.getByRole("dialog").locator("input:focus").fill(`${path}/`);
  await page.getByRole("button", { name: "Add (Enter)" }).click();
  const name = path.split("/").at(-1);
  await page.getByRole("button", { name: `New thread in ${name}` }).waitFor();
}
