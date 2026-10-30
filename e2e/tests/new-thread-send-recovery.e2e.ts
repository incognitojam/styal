import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { type App, openApp, startNewThread } from "../support/browser.ts";
import { type Environment, startEnvironment } from "../support/environment.ts";

function rpcMessages(data: string | Buffer): ReadonlyArray<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(data.toString());
  return (Array.isArray(parsed) ? parsed : [parsed]) as ReadonlyArray<Record<string, unknown>>;
}

describe("recover a new thread's first send", () => {
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

  it("follows the created thread when the reply to the first send is lost", async () => {
    const { page, composer } = app;
    await startNewThread(app);

    // The server accepts the first message, then the connection drops before its reply arrives.
    let dropped = false;
    await page.routeWebSocket(/\/ws(\?|$)/, (socket) => {
      const server = socket.connectToServer();
      let launchId: unknown;
      socket.onMessage((data) => {
        if (!dropped) {
          for (const message of rpcMessages(data)) {
            if (message._tag === "Request" && message.tag === "orchestration.launchThread") {
              launchId = message.id;
            }
          }
        }
        server.send(data);
      });
      server.onMessage((data) => {
        const lostReply =
          !dropped &&
          launchId !== undefined &&
          rpcMessages(data).some(
            (message) => message._tag === "Exit" && message.requestId === launchId,
          );
        if (!lostReply) {
          socket.send(data);
          return;
        }
        dropped = true;
        void server.close();
        void socket.close();
      });
    });

    // Routing applies to new sockets only, so reconnect through it.
    const draftUrl = page.url();
    await page.reload();
    await composer.waitFor();
    expect(page.url()).toBe(draftUrl);

    await composer.click();
    await page.keyboard.type("First message for a new thread");
    await composer.filter({ hasText: "First message for a new thread" }).waitFor();
    await page.getByRole("button", { name: "Submit message" }).click();

    await page.waitForURL((url) => !url.pathname.startsWith("/draft/"), { timeout: 60_000 });
    await page
      .getByText("Fake Codex reply to: First message for a new thread", { exact: true })
      .waitFor({ timeout: 60_000 });
    expect(dropped).toBe(true);
    expect((await composer.innerText()).trim()).toBe("");
    expect(
      await page
        .locator("[data-message-role=user]")
        .filter({ hasText: "First message for a new thread" })
        .count(),
    ).toBe(1);
    expect(environment.codexTurns()).toHaveLength(1);
  });
});
