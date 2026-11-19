/* oxlint-disable t3code/no-global-process-runtime -- Standalone packaging check runs outside Effect. */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export function verifyWorktreeCleanup(executable, entry) {
  NodeFS.mkdirSync(".scratch", { recursive: true });
  const fixture = NodeFS.realpathSync(NodeFS.mkdtempSync(".scratch/cleanup-packaged-"));
  try {
    const root = NodePath.join(fixture, "worktree");
    const target = NodePath.join(root, "dist");
    const outside = NodePath.join(fixture, "outside");
    NodeFS.mkdirSync(NodePath.join(target, "payload.asar"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: synthetic-fixture\n");
    NodeFS.writeFileSync(NodePath.join(target, "payload.asar", "content"), "synthetic payload");
    NodeFS.writeFileSync(outside, "outside sentinel");
    if (process.platform !== "win32")
      NodeFS.symlinkSync(outside, NodePath.join(target, "outside-link"));
    const content = NodeFS.statSync(NodePath.join(target, "payload.asar", "content"));
    const identity = NodeFS.lstatSync(root, { bigint: true });
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (/^(NODE_|ELECTRON_|T3CODE_|STYAL_)/.test(name)) delete env[name];
    }
    Object.assign(env, { ELECTRON_RUN_AS_NODE: "1", STYAL_HOME: NodePath.join(fixture, "state") });
    const result = NodeChildProcess.spawnSync(
      executable,
      [
        ...(entry ? [entry] : []),
        "__worktree-cleanup",
        root,
        "dist",
        String(identity.dev),
        String(identity.ino),
        "100",
        "10000",
      ],
      { cwd: fixture, env, encoding: "utf8", timeout: 30_000, windowsHide: true },
    );
    NodeAssert.ifError(result.error);
    NodeAssert.equal(NodeFS.readFileSync(outside, "utf8"), "outside sentinel");
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(root, ".git"), "utf8"),
      "gitdir: synthetic-fixture\n",
    );
    if (process.platform === "win32") {
      NodeAssert.notEqual(result.status, 0);
      NodeAssert.match(result.stderr, /Anchored deletion is unavailable on Windows/);
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(target, "payload.asar", "content"), "utf8"),
        "synthetic payload",
      );
      console.log("Packaged cleanup helper reached the Windows refusal; fixture preserved");
    } else {
      NodeAssert.equal(result.status, 0, result.stderr);
      NodeAssert.equal(result.stdout, String(content.blocks * 512));
      NodeAssert.equal(NodeFS.existsSync(target), false);
      console.log(
        "Packaged cleanup helper removed its fixture, counted allocated bytes, and preserved the outside sentinel",
      );
    }
  } finally {
    NodeFS.rmSync(fixture, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const [, , executable, entry] = process.argv;
  if (!executable)
    throw new Error("Usage: verify-worktree-cleanup.mjs <executable> [server-entry]");
  verifyWorktreeCleanup(NodePath.resolve(executable), entry && NodePath.resolve(entry));
}
