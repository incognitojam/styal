// @effect-diagnostics nodeBuiltinImport:off - the script under test only uses Node built-ins.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it, onTestFinished } from "vite-plus/test";

import { resolveTeardownTarget, teardownWorktree } from "./teardown-worktree.ts";

const tempDir = () => {
  const dir = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "teardown-")));
  onTestFinished(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const freePort = async () => {
  const probe = NodeNet.createServer().listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(probe, "listening");
  const { port } = probe.address() as NodeNet.AddressInfo;
  probe.close();
  await NodeEvents.EventEmitter.once(probe, "close");
  return port;
};

const startListener = async (cwd: string, port: number) => {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "-e",
      `require("node:net").createServer().listen(${port}, "127.0.0.1", () => console.log("up"))`,
    ],
    { cwd, stdio: ["ignore", "pipe", "inherit"] },
  );
  onTestFinished(() => void child.kill("SIGKILL"));
  await NodeEvents.EventEmitter.once(child.stdout, "data");
  return child;
};

describe("teardownWorktree", () => {
  it("stops listeners run from the worktree, leaves others, and deletes only listed paths", async () => {
    const worktree = tempDir();
    const elsewhere = tempDir();
    const appDir = NodePath.join(worktree, "apps/web");
    for (const dir of [
      appDir,
      ".styal/userdata",
      ".styal/caches",
      ".styal/worktrees/nested",
      ".scratch",
    ]) {
      NodeFS.mkdirSync(NodePath.resolve(worktree, dir), { recursive: true });
    }
    NodeFS.writeFileSync(NodePath.join(worktree, ".styal/setup-done"), "");
    NodeFS.writeFileSync(NodePath.join(worktree, ".scratch/notes.md"), "");

    const workspacePort = await freePort();
    const inside = await startListener(appDir, workspacePort);
    const outside = await startListener(elsewhere, workspacePort + 1);
    const insideExit = NodeEvents.EventEmitter.once(inside, "exit");

    await teardownWorktree({ worktree, workspacePort });

    await insideExit;
    assert.strictEqual(outside.exitCode, null);
    assert.isNull(outside.signalCode);
    assert.isFalse(NodeFS.existsSync(NodePath.join(worktree, ".styal/userdata")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(worktree, ".styal/caches")));
    assert.isTrue(NodeFS.existsSync(NodePath.join(worktree, ".styal/worktrees/nested")));
    assert.isTrue(NodeFS.existsSync(NodePath.join(worktree, ".styal/setup-done")));
    assert.isTrue(NodeFS.existsSync(NodePath.join(worktree, ".scratch/notes.md")));
  });
});

describe("teardownWorktree registered runners", () => {
  const startIdle = (cwd: string) => {
    const child = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd,
      stdio: "ignore",
    });
    onTestFinished(() => void child.kill("SIGKILL"));
    return child;
  };

  it("stops a registered runner without a reserved range, and ignores a reused or dead PID", async () => {
    const worktree = tempDir();
    const elsewhere = tempDir();
    const runners = NodePath.join(worktree, ".styal/dev-runners");
    NodeFS.mkdirSync(runners, { recursive: true });

    const runner = startIdle(worktree);
    const reused = startIdle(elsewhere);
    const dead = startIdle(worktree);
    const deadExit = NodeEvents.EventEmitter.once(dead, "exit");
    dead.kill("SIGKILL");
    await deadExit;
    for (const child of [runner, reused, dead]) {
      NodeFS.writeFileSync(NodePath.join(runners, String(child.pid)), "");
    }
    const runnerExit = NodeEvents.EventEmitter.once(runner, "exit");

    await teardownWorktree({ worktree, workspacePort: undefined });

    await runnerExit;
    assert.strictEqual(reused.exitCode, null);
    assert.isNull(reused.signalCode);
    assert.isFalse(NodeFS.existsSync(runners));
  });
});

describe("teardownWorktree process groups", () => {
  it("stops a runner's whole group when every member is inside the worktree", async () => {
    const worktree = tempDir();
    const runners = NodePath.join(worktree, ".styal/dev-runners");
    NodeFS.mkdirSync(runners, { recursive: true });
    // The grandchild shares stdout, so the pipe closes only once the whole group has gone.
    const runner = NodeChildProcess.spawn(
      process.execPath,
      [
        "-e",
        `require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); setInterval(() => {}, 1000); console.log("up");`,
      ],
      { cwd: worktree, detached: true, stdio: ["ignore", "pipe", "inherit"] },
    );
    onTestFinished(() => {
      try {
        process.kill(-runner.pid!, "SIGKILL");
      } catch {}
    });
    await NodeEvents.EventEmitter.once(runner.stdout, "data");
    NodeFS.writeFileSync(NodePath.join(runners, String(runner.pid)), "");
    const groupGone = NodeEvents.EventEmitter.once(runner.stdout, "close");

    await teardownWorktree({ worktree, workspacePort: await freePort() });

    await groupGone;
  });
});

describe("resolveTeardownTarget", () => {
  it("refuses a checkout that is not the thread's worktree", () => {
    const checkout = tempDir();
    const other = tempDir();
    assert.isUndefined(resolveTeardownTarget({ STYAL_WORKSPACE_PORT: "20020" }, checkout));
    assert.isUndefined(
      resolveTeardownTarget(
        { STYAL_WORKTREE_PATH: other, STYAL_WORKSPACE_PORT: "20020" },
        checkout,
      ),
    );
    assert.isUndefined(
      resolveTeardownTarget({ STYAL_WORKTREE_PATH: checkout, STYAL_WORKSPACE_PORT: "" }, checkout),
    );
    assert.deepStrictEqual(resolveTeardownTarget({ STYAL_WORKTREE_PATH: checkout }, checkout), {
      worktree: checkout,
      workspacePort: undefined,
    });
    assert.deepStrictEqual(
      resolveTeardownTarget(
        { STYAL_WORKTREE_PATH: checkout, STYAL_WORKSPACE_PORT: "20020" },
        checkout,
      ),
      { worktree: checkout, workspacePort: 20020 },
    );
  });
});
