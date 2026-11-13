// @effect-diagnostics nodeBuiltinImport:off - the script under test only uses Node built-ins.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { assert, expect, describe, it, onTestFinished, vi } from "vite-plus/test";

import { resolveTeardownTarget, teardownWorktree } from "./teardown-worktree.ts";

const tempDir = () => {
  const dir = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(import.meta.dirname, "../.scratch/settle-test-")),
  );
  onTestFinished(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const fixture = () => {
  const root = tempDir();
  const main = NodePath.join(root, ".styal/worktrees/main");
  const worktree = NodePath.join(root, ".styal/worktrees/fixture");
  NodeFS.mkdirSync(main, { recursive: true });
  const git = (cwd: string, args: Array<string>) => {
    const result = NodeChildProcess.spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git(main, ["init"]);
  git(main, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  git(main, ["worktree", "add", "--detach", worktree]);
  NodeFS.writeFileSync(
    NodePath.join(worktree, ".gitignore"),
    ".styal/\nnode_modules/\nbuild/\n.turbo/\n*.tsbuildinfo\n.scratch/\n.env*\ntest-results/\n",
  );
  NodeFS.writeFileSync(NodePath.join(worktree, "package.json"), "{}");
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(worktree);
  onTestFinished(() => cwd.mockRestore());
  return { worktree, main, git };
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
    const { worktree } = fixture();
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

    await teardownWorktree({ worktree, workspacePort, stripRegenerable: true });

    await insideExit;
    assert.strictEqual(outside.exitCode, null);
    assert.isNull(outside.signalCode);
    assert.isTrue(NodeFS.existsSync(NodePath.join(worktree, ".styal/userdata")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(worktree, ".styal/caches")));
    assert.isTrue(NodeFS.existsSync(NodePath.join(worktree, ".styal/worktrees/nested")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(worktree, ".styal/setup-done")));
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
    const { worktree } = fixture();
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

    await teardownWorktree({ worktree, workspacePort: undefined, stripRegenerable: true });

    await runnerExit;
    assert.strictEqual(reused.exitCode, null);
    assert.isNull(reused.signalCode);
    assert.isFalse(NodeFS.existsSync(runners));
  });
});

describe("teardownWorktree process groups", () => {
  it("stops a runner's whole group when every member is inside the worktree", async () => {
    const { worktree } = fixture();
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

    await teardownWorktree({ worktree, workspacePort: await freePort(), stripRegenerable: true });

    await groupGone;
  });
});

describe("resolveTeardownTarget", () => {
  it("refuses a checkout that is not the thread's worktree", () => {
    const { worktree: checkout } = fixture();
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

it("selects only listed ignored paths, preserving work, links and nested checkouts", async () => {
  const { worktree, main, git } = fixture();
  const cases = [
    { path: "node_modules/pkg/index.js", ignored: true, listed: true, removed: true },
    { path: "apps/web/node_modules/pkg/file", ignored: true, listed: true, removed: true },
    { path: "build/output", ignored: true, listed: true, removed: false },
    { path: ".turbo/cache", ignored: true, listed: true, removed: true },
    { path: "cache.tsbuildinfo", ignored: true, listed: true, removed: true },
    { path: "dist/untracked", ignored: false, listed: true, removed: false },
    { path: "notes/ignored", ignored: true, listed: false, removed: false },
    { path: "source/untracked", ignored: false, listed: false, removed: false },
    { path: ".scratch/notes", ignored: true, listed: false, removed: false },
    { path: ".env.local", ignored: true, listed: false, removed: false },
    { path: ".styal/userdata/state.sqlite", ignored: true, listed: false, removed: false },
    { path: "test-results/result", ignored: true, listed: false, removed: false },
    { path: "tracked/build/source", ignored: false, listed: true, removed: false },
    { path: "build/.env.secret", ignored: true, listed: false, removed: false },
  ];
  NodeFS.appendFileSync(NodePath.join(worktree, ".gitignore"), "notes/\n");
  for (const entry of cases) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(worktree, entry.path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(worktree, entry.path), "synthetic");
  }
  git(worktree, ["add", "-f", "tracked/build/source"]);
  for (const entry of cases) {
    const result = NodeChildProcess.spawnSync("git", [
      "-C",
      worktree,
      "check-ignore",
      "-q",
      "--",
      entry.path,
    ]);
    assert.equal(result.status === 0, entry.ignored, entry.path);
  }
  NodeFS.symlinkSync(main, NodePath.join(worktree, "build/outside"), "dir");
  NodeFS.mkdirSync(NodePath.join(worktree, "linked"));
  NodeFS.symlinkSync(main, NodePath.join(worktree, "linked/node_modules"), "dir");
  NodeFS.writeFileSync(NodePath.join(main, "keep"), "synthetic");
  NodeFS.symlinkSync(NodePath.join(main, "keep"), NodePath.join(worktree, ".env"));
  NodeFS.symlinkSync(
    NodePath.join(worktree, "source/untracked"),
    NodePath.join(worktree, "node_modules/internal"),
  );
  git(worktree, ["worktree", "add", "--detach", NodePath.join(worktree, "nested")]);
  NodeFS.mkdirSync(NodePath.join(worktree, "nested/build"));
  NodeFS.writeFileSync(NodePath.join(worktree, "nested/build/keep"), "synthetic");

  await teardownWorktree({ worktree, workspacePort: undefined, dryRun: true });
  for (const entry of cases)
    assert.isTrue(NodeFS.existsSync(NodePath.join(worktree, entry.path)), entry.path);

  await teardownWorktree({ worktree, workspacePort: undefined, stripRegenerable: true });
  // A protected file or symlink keeps its entire enclosing candidate intact.
  for (const entry of cases) {
    assert.equal(
      NodeFS.existsSync(NodePath.join(worktree, entry.path)),
      !entry.removed,
      entry.path,
    );
  }
  assert.isTrue(NodeFS.lstatSync(NodePath.join(worktree, "linked/node_modules")).isSymbolicLink());
  assert.isTrue(NodeFS.existsSync(NodePath.join(main, "keep")));
  assert.isTrue(NodeFS.lstatSync(NodePath.join(worktree, ".env")).isSymbolicLink());
  assert.equal(NodeFS.readFileSync(NodePath.join(main, "keep"), "utf8"), "synthetic");
  assert.isTrue(NodeFS.existsSync(NodePath.join(worktree, "nested/build/keep")));
});

it("refuses the main checkout even under a styal worktrees directory", async () => {
  const { main } = fixture();
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(main);
  onTestFinished(() => cwd.mockRestore());
  await expect(
    teardownWorktree({ worktree: main, workspacePort: undefined, dryRun: true }),
  ).rejects.toThrow(/main checkout/);
});

it("uses the target index despite inherited Git overrides, and refuses fake and main roots", async () => {
  const { worktree, main, git } = fixture();
  NodeFS.writeFileSync(NodePath.join(worktree, "package.json"), "{}");
  NodeFS.appendFileSync(NodePath.join(worktree, ".gitignore"), "dist/\n");
  NodeFS.mkdirSync(NodePath.join(worktree, "dist"));
  NodeFS.writeFileSync(NodePath.join(worktree, "dist/source.ts"), "synthetic source");
  git(worktree, ["add", "-f", "dist/source.ts"]);
  const sibling = NodePath.join(main, "../other");
  git(main, ["worktree", "add", "--detach", sibling]);
  const siblingGitDir = NodeChildProcess.spawnSync(
    "git",
    ["-C", sibling, "rev-parse", "--absolute-git-dir"],
    { encoding: "utf8" },
  ).stdout.trim();
  vi.stubEnv("GIT_DIR", siblingGitDir);
  vi.stubEnv("GIT_WORK_TREE", worktree);
  vi.stubEnv("GIT_INDEX_FILE", NodePath.join(siblingGitDir, "index"));
  vi.stubEnv("GIT_CONFIG_COUNT", "1");
  vi.stubEnv("GIT_CONFIG_KEY_0", "core.excludesFile");
  vi.stubEnv("GIT_CONFIG_VALUE_0", NodePath.join(main, "ignore"));
  NodeFS.writeFileSync(NodePath.join(main, "ignore"), "*\n");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  await teardownWorktree({ worktree, workspacePort: undefined, stripRegenerable: true });
  assert.isTrue(NodeFS.existsSync(NodePath.join(worktree, "dist/source.ts")));
  const fake = NodePath.join(main, "../fake");
  NodeFS.mkdirSync(fake);
  const cwd = vi.spyOn(process, "cwd");
  onTestFinished(() => cwd.mockRestore());
  for (const target of [main, fake]) {
    cwd.mockReturnValue(target);
    vi.stubEnv("GIT_WORK_TREE", target);
    await expect(
      teardownWorktree({ worktree: target, workspacePort: undefined, stripRegenerable: true }),
    ).rejects.toThrow();
  }
});

it("preserves case variants of protected work and source directories without package manifests", async () => {
  const { worktree, git } = fixture();
  git(worktree, ["config", "core.ignorecase", "true"]);
  NodeFS.appendFileSync(NodePath.join(worktree, ".gitignore"), "dist/\ncoverage/\n");
  const paths = [
    ".SCRATCH/build/source",
    ".SCRATCH/dist/source",
    ".ＳＣＲＡＴＣＨ/node_modules/source",
    "test-RESULTS/dist/source",
    ".STYAL/USERDATA/build/source",
    "plain/build/ignored-source",
    "plain/dist/ignored-source",
    "plain/coverage/source",
  ];
  for (const relative of paths) {
    const target = NodePath.join(worktree, relative);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, "synthetic source");
    NodeFS.writeFileSync(NodePath.join(NodePath.dirname(target), "package.json"), "{}");
  }
  await teardownWorktree({ worktree, workspacePort: undefined, stripRegenerable: true });
  for (const relative of paths)
    assert.isTrue(NodeFS.existsSync(NodePath.join(worktree, relative)), relative);
});

it("reports eligible files without stripping unless explicitly opted in", async () => {
  const { worktree } = fixture();
  NodeFS.mkdirSync(NodePath.join(worktree, "node_modules"));
  NodeFS.mkdirSync(NodePath.join(worktree, ".styal"));
  NodeFS.writeFileSync(NodePath.join(worktree, "node_modules/file"), "synthetic");
  NodeFS.writeFileSync(NodePath.join(worktree, ".styal/setup-done"), "");
  await teardownWorktree({ worktree, workspacePort: undefined });
  assert.isTrue(NodeFS.existsSync(NodePath.join(worktree, "node_modules/file")));
  assert.isTrue(NodeFS.existsSync(NodePath.join(worktree, ".styal/setup-done")));
});

it("reports partial deletion precisely and leaves a failed strip retryable", async () => {
  const { worktree } = fixture();
  const readonly = NodePath.join(worktree, "build/readonly");
  NodeFS.mkdirSync(readonly, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(worktree, ".styal"));
  NodeFS.writeFileSync(NodePath.join(worktree, ".styal/setup-done"), "");
  NodeFS.writeFileSync(NodePath.join(readonly, "file"), "synthetic");
  NodeFS.chmodSync(readonly, 0o555);
  onTestFinished(() => {
    if (NodeFS.existsSync(readonly)) NodeFS.chmodSync(readonly, 0o755);
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());
  await expect(
    teardownWorktree({ worktree, workspacePort: undefined, stripRegenerable: true }),
  ).rejects.toThrow();
  assert.isFalse(NodeFS.existsSync(NodePath.join(worktree, ".styal/setup-done")));
  assert.isTrue(NodeFS.existsSync(NodePath.join(readonly, "file")));
  assert.include(String(errors.mock.calls[0]), ".styal/setup-done");
  assert.include(String(errors.mock.calls[1]), "build/readonly/file");
  NodeFS.chmodSync(readonly, 0o755);
  await teardownWorktree({ worktree, workspacePort: undefined, stripRegenerable: true });
  assert.isFalse(NodeFS.existsSync(NodePath.join(worktree, "build")));
});
