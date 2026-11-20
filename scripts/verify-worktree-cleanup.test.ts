// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

it("starts the verifier through a directory alias", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cleanup-entry-"));
  try {
    const alias = NodePath.join(root, "scripts");
    NodeFS.symlinkSync(NodeURL.fileURLToPath(new URL(".", import.meta.url)), alias, "junction");
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(alias, "verify-worktree-cleanup.mjs")],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Usage: verify-worktree-cleanup.mjs");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
