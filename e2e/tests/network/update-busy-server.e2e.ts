// @effect-diagnostics nodeBuiltinImport:off - e2e harness runs plain Node outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  type App,
  addEnvironment,
  allowOrigin,
  openApp,
  runPaletteItem,
} from "../../support/browser.ts";
import { type Environment, startEnvironment } from "../../support/environment.ts";
import { type PublishedServer, startPublishedServer } from "../../support/publishedServer.ts";

// Versions and web build as in update-everything.e2e.ts.
const CLIENT_VERSION = process.env.E2E_CLIENT_VERSION;
const SERVER_VERSION = process.env.E2E_PREVIOUS_SERVER_VERSION;

describe("update a busy server from the sidebar", () => {
  let environment: Environment;
  let server: PublishedServer;
  let app: App;

  beforeAll(async () => {
    if (!CLIENT_VERSION || !SERVER_VERSION) {
      throw new Error("Set E2E_CLIENT_VERSION and E2E_PREVIOUS_SERVER_VERSION.");
    }
    environment = await startEnvironment();
    server = await startPublishedServer(SERVER_VERSION);
    app = await openApp(environment);
    // The client asks npm whether the release it would install is published.
    allowOrigin(app.page, "https://registry.npmjs.org");
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await Promise.all([environment?.stop(), server?.stop()]);
    }
  });

  it("asks before interrupting a terminal command, and updates once confirmed", async () => {
    const { page } = app;
    const projectPath = NodePath.join(server.root, "busy-project");
    NodeFS.mkdirSync(projectPath);
    await addEnvironment(page, server.pairingUrl);
    await page.goto(new URL("/", page.url()).href);
    await app.composer.waitFor();
    // Offered once npm confirms the client's version is published and the server's config has
    // loaded, which is also when the server can take a new project.
    const update = page.getByRole("button", { name: "Update 1 server" });
    await update.waitFor({ timeout: 60_000 });

    // Both environments run on this machine, so they share its name; the server is the one
    // that is not this device.
    await runPaletteItem(page, "add project", "Add project");
    const palette = page.getByRole("dialog");
    await palette.getByText("Environments").waitFor();
    await palette
      .locator("[data-slot=command-item], [role=option]")
      .filter({ hasNotText: "This device" })
      .first()
      .click();
    await palette.getByText("Local folder").click();
    await palette.locator("input:focus").fill(`${projectPath}/`);
    await page.getByRole("button", { name: "Add (Enter)" }).click();
    await page.getByRole("button", { name: "New thread in busy-project" }).waitFor();
    await palette.waitFor({ state: "detached" });
    await app.composer.waitFor();

    await page.keyboard.press("ControlOrMeta+j");
    const terminalInput = page.getByRole("textbox", { name: "Terminal input" });
    await terminalInput.waitFor();
    await page.locator("[data-terminal-owner=drawer]").click();
    await expect
      .poll(() => terminalInput.evaluate((el) => el === document.activeElement))
      .toBe(true);
    // The terminal draws to a canvas, so the file is what shows the command has started.
    await page.keyboard.type("touch started && sleep 600");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => NodeFS.existsSync(NodePath.join(projectPath, "started")), { timeout: 30_000 })
      .toBe(true);

    const confirmation = page.getByRole("alertdialog");
    await update.click();
    await confirmation.getByText("1 terminal session will be interrupted.").waitFor();
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await confirmation.waitFor({ state: "detached" });
    expect(server.activeVersion()).toBe(SERVER_VERSION);

    // Consent skips the server's own recheck, which would refuse the running command.
    await update.click();
    await confirmation.getByText("1 terminal session will be interrupted.").waitFor();
    await confirmation.getByRole("button", { name: "Update" }).click();
    await expect
      .poll(() => server.activeVersion(), { timeout: 240_000, interval: 1_000 })
      .toBe(CLIENT_VERSION);
    await expect(update.waitFor({ state: "detached", timeout: 60_000 })).resolves.toBeUndefined();
  }, 360_000);
});
