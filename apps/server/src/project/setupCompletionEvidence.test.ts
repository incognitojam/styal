// @effect-diagnostics nodeBuiltinImport:off -- Real Git fixtures exercise repository scope and completion evidence.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";

import { isLinkedProjectWorktree, readSetupCheckoutIdentity } from "./setupCompletionEvidence.ts";

it("accepts only linked worktrees of the project repository under a clean Git environment", async () => {
  const scratch = NodePath.resolve(import.meta.dirname, "../../../../.scratch");
  NodeFS.mkdirSync(scratch, { recursive: true });
  const root = NodeFS.mkdtempSync(NodePath.join(scratch, "setup-scope-"));
  try {
    const main = NodePath.join(root, "main");
    const linked = NodePath.join(root, "linked");
    const stale = NodePath.join(root, "stale");
    NodeFS.mkdirSync(main);
    NodeFS.mkdirSync(stale);
    const git = (...args: string[]) => NodeChildProcess.execFileSync("git", ["-C", main, ...args]);
    git("init", "--separate-git-dir", NodePath.join(root, "git"));
    git(
      "-c",
      "user.name=Example",
      "-c",
      "user.email=example@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "init",
    );
    git("worktree", "add", "-b", "feature", linked);
    NodeFS.symlinkSync(main, NodePath.join(root, "alias"));
    NodeFS.writeFileSync(NodePath.join(stale, ".git"), "gitdir: /missing/repository\n");
    const gitDirectory = git("-C", linked, "rev-parse", "--absolute-git-dir").toString().trimEnd();
    const rootStat = NodeFS.statSync(linked, { bigint: true });
    vi.stubEnv("GIT_DIR", NodePath.join(root, "git"));
    vi.stubEnv("GIT_WORK_TREE", main);
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.worktree");
    vi.stubEnv("GIT_CONFIG_VALUE_0", stale);
    expect(await readSetupCheckoutIdentity(linked)).toEqual({
      version: 2,
      device: String(rootStat.dev),
      inode: String(rootStat.ino),
      gitDirectory,
    });
    expect(await isLinkedProjectWorktree(main, linked)).toBe(true);
    expect(await isLinkedProjectWorktree(NodePath.join(root, "alias"), main)).toBe(false);
    expect(await isLinkedProjectWorktree(main, stale)).toBe(false);
    expect(await isLinkedProjectWorktree(stale, linked)).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
