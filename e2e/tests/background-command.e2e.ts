import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { type App, openApp, sendMessage } from "../support/browser.ts";
import { type Environment, startEnvironment } from "../support/environment.ts";

describe("native background commands", () => {
  let environment: Environment;
  let app: App;

  beforeAll(async () => {
    environment = await startEnvironment({
      scenario: {
        turns: [
          {
            match: "Start the server",
            steps: [
              { type: "backgroundCommand", command: "fixture-server", processId: "4242" },
              { type: "message", text: "Server started in the background." },
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

  it("keeps a command visible after its turn ends and stops it through the provider", async () => {
    const { page } = app;
    await sendMessage(app, "Start the server", "Server started in the background.");
    const running = page.getByText(/^Running:.*fixture-server/);
    await running.waitFor();
    const originalTurn = environment.codexTurns()[0]!;

    await page.reload();
    await running.waitFor();
    if (process.env.E2E_KEEP_STATE) {
      await page.locator("[data-chat-composer-stack]").screenshot({
        path: `${environment.root}/background-running.png`,
      });
    }
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await running.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden" });
    const commandHistory = page.getByText("fixture-server", { exact: true });
    await commandHistory.waitFor();
    if (process.env.E2E_KEEP_STATE) {
      await page.locator("[data-chat-composer-stack]").screenshot({
        path: `${environment.root}/background-stopped.png`,
      });
    }

    expect(
      environment
        .codexRpcRequests()
        .filter((request) => request.method === "thread/backgroundTerminals/terminate"),
    ).toEqual([
      {
        method: "thread/backgroundTerminals/terminate",
        params: { threadId: originalTurn.threadId, processId: "4242" },
      },
    ]);

    await page.reload();
    await commandHistory.waitFor();
    expect(await running.count()).toBe(0);
    await sendMessage(app, "List the files");
    expect(environment.codexTurns().map((turn) => turn.threadId)).toEqual([
      originalTurn.threadId,
      originalTurn.threadId,
    ]);
  });
});
