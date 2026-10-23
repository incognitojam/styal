import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { type App, addEnvironment, openApp } from "../../support/browser.ts";
import { type Environment, startEnvironment } from "../../support/environment.ts";
import { type PublishedServer, startPublishedServer } from "../../support/publishedServer.ts";

// The web bundle must be built with APP_VERSION set to the client version; see
// .github/workflows/fork-e2e-network.yml. Both versions are published @styal/cli releases on
// the same channel, the server's older than the client's.
const CLIENT_VERSION = process.env.E2E_CLIENT_VERSION;
const SERVER_VERSION = process.env.E2E_PREVIOUS_SERVER_VERSION;

describe("update everything from the sidebar", () => {
  let environment: Environment;
  let server: PublishedServer;
  let app: App;

  beforeAll(async () => {
    if (!CLIENT_VERSION || !SERVER_VERSION) {
      throw new Error("Set E2E_CLIENT_VERSION and E2E_PREVIOUS_SERVER_VERSION.");
    }
    [environment, server] = await Promise.all([
      startEnvironment(),
      startPublishedServer(SERVER_VERSION),
    ]);
    app = await openApp(environment);
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([environment?.stop(), server?.stop()]);
  });

  it("updates a server behind this client through its service launcher", async () => {
    const { page } = app;
    await addEnvironment(page, server.pairingUrl);
    await page.goto(new URL("/", page.url()).href);

    // Offered only once npm confirms the client's version is published.
    const update = page.getByRole("button", { name: "Update 1 server" });
    await update.click({ timeout: 60_000 });
    const confirmation = page.getByRole("alertdialog");
    await confirmation.getByText(`server to ${CLIENT_VERSION}`).waitFor();
    await confirmation.getByRole("button", { name: "Update" }).click();

    // The server has nothing running, so the activity check goes ahead without asking.
    // The launcher records the version it switched to once the new server is up.
    await expect
      .poll(() => server.activeVersion(), { timeout: 240_000, interval: 1_000 })
      .toBe(CLIENT_VERSION);
    await expect(update.waitFor({ state: "detached", timeout: 60_000 })).resolves.toBeUndefined();
  }, 360_000);
});
