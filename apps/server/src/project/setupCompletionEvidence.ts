// @effect-diagnostics nodeBuiltinImport:off -- Git validation replaces the entire inherited environment.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

function cleanGit() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return async (cwd: string, args: string[]) =>
    (await exec("git", ["-C", cwd, ...args], { env })).stdout.replace(/\n$/, "");
}

export async function readSetupCheckoutIdentity(worktreePath: string) {
  try {
    const git = cleanGit();
    const root = await NodeFSP.stat(worktreePath, { bigint: true });
    return {
      version: 2 as const,
      device: String(root.dev),
      inode: String(root.ino),
      gitDirectory: await git(worktreePath, ["rev-parse", "--absolute-git-dir"]),
    };
  } catch {
    return null;
  }
}

export async function isLinkedProjectWorktree(projectRoot: string, worktreePath: string) {
  const git = cleanGit();
  try {
    const target = await NodeFSP.realpath(worktreePath);
    const project = await NodeFSP.realpath(projectRoot);
    if (target === project) return false;
    const common = await NodeFSP.realpath(
      await git(project, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    );
    if (
      common !==
      (await NodeFSP.realpath(
        await git(target, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      ))
    )
      return false;
    const entries = (await git(project, ["worktree", "list", "--porcelain", "-z"])).split("\0\0");
    // Git lists the main checkout first, including separate-git-dir checkouts.
    for (const entry of entries.slice(1)) {
      const root = entry
        .split("\0")
        .find((line) => line.startsWith("worktree "))
        ?.slice(9);
      if (root && (await NodeFSP.realpath(root)) === target) return true;
    }
    return false;
  } catch {
    return false;
  }
}
