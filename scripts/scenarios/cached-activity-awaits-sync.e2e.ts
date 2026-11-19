import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A confirmed summary ends cached activity while thread detail catches up",
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
      const ids = new Set(projection.turnItems.filter(item => item.type === "user_message" || item.input === "fixture-server").map(item => item.id));
      const answer = projection.turnItems.findLast(item => item.type === "assistant_message");
      answer.text = "Fixture command started.";
      ids.add(answer.id);
      projection.turnItems = projection.turnItems.filter(item => ids.has(item.id));
      projection.visibleTurnItems = projection.visibleTurnItems.filter(row => ids.has(row.item.id));
      for (const row of projection.visibleTurnItems) if (row.item.id === answer.id) row.item.text = answer.text;
      projection.messages = projection.messages.filter(message => message.role === "user" || message.id === answer.messageId);
      for (const message of projection.messages) if (message.id === answer.messageId) message.text = answer.text;
      const shellResponse = await fetch("/api/orchestration/shell", { headers: { "x-t3-orchestration-protocol": "2" } });
      const shell = await shellResponse.json();
      const row = shell.threads.find(thread => thread.id === threadId);
      row.status = "running";
      row.activityRunStatus = "running";
      row.activeRunId = projection.runs[0].id;
      row.latestRunCompletedAt = null;
      shell.snapshotSequence = 0;
      // Force a fresh server snapshot when the held connection is released.
      snapshot.snapshotSequence = 0;
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("styal:connection-runtime");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = database.transaction(["thread", "shell"], "readwrite");
      transaction
        .objectStore("thread")
        .put(
          JSON.stringify({ schemaVersion: 5, environmentId, threadId, snapshot }),
          \`\${environmentId}:\${threadId}\`,
        );
      transaction.objectStore("shell").put(JSON.stringify({ schemaVersion: 3, environmentId, snapshot: shell }), environmentId);
      localStorage.setItem("stale-live-mode", "all");
      await new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
      return null;
    }`);

    await browser.addInitScript(`(() => {
  let mode = localStorage.getItem('stale-live-mode') || 'none';
  const pending = [];
  const requests = [];
  const responses = [];
  const blocks = kind => mode === 'all' || (mode === 'detail' && kind === 'detail');
  const setMode = next => {
    mode = next;
    localStorage.setItem('stale-live-mode', next);
    const ready = pending.splice(0);
    for (const item of ready) {
      if (blocks(item.kind)) pending.push(item);
      else item.deliver();
    }
  };
  window.staleLiveGate = { setMode, requests, responses, releaseShell: () => setMode('detail'), releaseDetail: () => setMode('none') };
  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    const url = String(args[0] instanceof Request ? args[0].url : args[0]);
    const kind = url.includes('/api/orchestration/threads/') ? 'detail' : url.includes('/api/orchestration/shell') ? 'shell' : null;
    if (kind && blocks(kind)) await new Promise(resolve => pending.push({kind, deliver:resolve}));
    return originalFetch(...args);
  };
  const Original = window.WebSocket;
  window.WebSocket = class extends Original {
    constructor(...args) {
      super(...args);
      if (new URL(String(args[0]), location.href).pathname !== '/ws') return;
      this.kinds = new Map();
      this.stops = new Set();
      this.injecting = false;
      const deliver = frame => {
        this.injecting = true;
        this.dispatchEvent(new MessageEvent('message', {data:JSON.stringify(frame)}));
        this.injecting = false;
      };
      this.addEventListener('message', event => {
        if (this.injecting || typeof event.data !== 'string') return;
        let decoded;
        try { decoded = JSON.parse(event.data); } catch { return; }
        const frames = Array.isArray(decoded) ? decoded : [decoded];
        for (const frame of frames) if (this.stops.has(String(frame.requestId))) responses.push(frame);
        if (!frames.some(frame => this.kinds.has(String(frame.requestId)) && blocks(this.kinds.get(String(frame.requestId))))) return;
        event.stopImmediatePropagation();
        for (const frame of frames) {
          const kind = this.kinds.get(String(frame.requestId));
          if (kind && blocks(kind)) pending.push({kind, deliver:() => deliver(frame)});
          else deliver(frame);
        }
      });
    }
    send(data) {
      let decoded;
      try { decoded = JSON.parse(data); } catch { return super.send(data); }
      for (const frame of Array.isArray(decoded) ? decoded : [decoded]) {
        if (frame._tag !== 'Request') continue;
        const kind = frame.tag === 'orchestration.subscribeThread' ? 'detail' : frame.tag === 'orchestration.subscribeShell' ? 'shell' : null;
        if (kind) this.kinds.set(String(frame.id), kind);
        requests.push({tag:frame.tag, id:frame.id});
        if ((JSON.stringify(frame.payload) || '').includes('thread.stop')) this.stops.add(String(frame.id));
      }
      return super.send(data);
    }
  };
})()
`);
    await browser.reload();
    await expect(screen.getByText("Running fixture-server", { exact: false })).toBeVisible({
      timeout: 120_000,
    });
    await expect(screen.getByText("Last seen working", { exact: true })).toBeVisible();
    await app.screenshot("unknown-status");
    await expect(browser.locator(".live-tool-shine").first()).toBeHidden();
    await browser.evaluate(`async () => {
      window.staleLiveGate.releaseShell();
      const {appAtomRegistry: registry} = await import('/src/rpc/atomRegistry.ts');
      const {environmentShell} = await import('/src/state/shell.ts');
      const environmentId = decodeURIComponent(location.pathname.split('/')[1]);
      const atom = environmentShell.statusAtom(environmentId);
      if (registry.get(atom) !== 'live') await new Promise(resolve => {
        const unsubscribe = registry.subscribe(atom, status => { if (status === 'live') { unsubscribe(); resolve(); } });
      });
      return null;
    }`);
    await app.screenshot("known-ended");
    await expect(screen.getByText("Last seen working", { exact: true })).toBeHidden();
    await expect(screen.getByText("Running fixture-server", { exact: false })).toBeHidden();
    await expect(screen.getByRole("button", "Stop generation")).toBeHidden();
    await browser.evaluate("() => { window.staleLiveGate.releaseDetail(); return null; }");
    await expect(screen.getByText("Worked for", { exact: false })).toBeVisible();
  },
);
