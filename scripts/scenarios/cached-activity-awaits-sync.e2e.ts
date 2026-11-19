import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Cached activity stays unconfirmed until the server catches up",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("sync-fixture");
    await t3.thread({
      project,
      title: "Reload sync fixture",
      messages: ["Inspect the sample module"],
      model: "showcase",
    });
    await t3.open();
    const threadLink = screen.getByText("Reload sync fixture", { exact: true }).first();
    await expect(threadLink).toBeVisible({ timeout: 120_000 });
    await threadLink.tap();
    await expect(screen.getByText("This turn is a replay.", { exact: false })).toBeVisible();

    // A waiting run is cacheable before its checkpoint finishes. Seed that older copy
    // deterministically; the real Replay turn has already completed on the server.
    await browser.evaluate(`async () => {
      const [environmentId, threadId] = location.pathname
        .split("/")
        .slice(1)
        .map(decodeURIComponent);
      const response = await fetch(\`/api/orchestration/threads/\${encodeURIComponent(threadId)}\`, {
        headers: { "x-t3-orchestration-protocol": "2" },
      });
      if (!response.ok) throw new Error(\`Snapshot: \${response.status}\`);
      const snapshot = await response.json();
      const projection = snapshot.projection;
      projection.runs[0].status = "waiting";
      projection.runs[0].completedAt = null;
      for (const item of [
        ...projection.turnItems,
        ...projection.visibleTurnItems.map((row) => row.item),
      ]) {
        if (item.type === "command_execution" && item.input === "vp test run") {
          item.status = "running";
          item.completedAt = null;
          item.input = "fixture-server";
        }
      }
      // Force a fresh server snapshot when the held connection is released.
      snapshot.snapshotSequence = 0;
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("styal:connection-runtime");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = database.transaction("thread", "readwrite");
      transaction
        .objectStore("thread")
        .put(
          JSON.stringify({ schemaVersion: 5, environmentId, threadId, snapshot }),
          \`\${environmentId}:\${threadId}\`,
        );
      await new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
      return null;
    }`);

    // Hold the first server state, rather than relying on a slow or loaded machine.
    await browser.addInitScript(`(() => {
      const pending = [];
      let held = true;
      Object.assign(window, {
        releaseSync: () => {
          held = false;
          pending.splice(0).forEach((release) => release());
        },
      });
      const fetchOriginal = window.fetch;
      window.fetch = async (...args) => {
        if (
          held &&
          String(args[0] instanceof Request ? args[0].url : args[0]).includes("/api/orchestration")
        ) {
          await new Promise((resolve) => pending.push(resolve));
        }
        return fetchOriginal(...args);
      };
      const Socket = window.WebSocket;
      window.WebSocket = class extends Socket {
        constructor(url, protocols) {
          super(url, protocols);
          if (new URL(String(url), location.href).pathname !== "/ws") return;
          this.addEventListener("message", (event) => {
            if (!held) return;
            event.stopImmediatePropagation();
            pending.push(() =>
              this.dispatchEvent(new MessageEvent("message", { data: event.data })),
            );
          });
        }
      };
    })()`);
    await browser.reload();
    await expect(screen.getByText("Running fixture-server", { exact: false })).toBeVisible({
      timeout: 120_000,
    });
    await app.screenshot("held-sync");
    await expect(browser.locator(".live-tool-shine").first()).toBeHidden();
    await expect(screen.getByText("Last seen working", { exact: true })).toBeVisible();
    await expect(screen.getByRole("button", "Stop generation")).toBeHidden();

    await browser.evaluate("() => { window.releaseSync(); return null; }");
    await expect(screen.getByText("Worked for", { exact: false })).toBeVisible();
    await expect(screen.getByText("Last seen working", { exact: true })).toBeHidden();
  },
);
