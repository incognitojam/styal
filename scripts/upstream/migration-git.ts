// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from "node:child_process";

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { UpstreamMigrationGit } from "./lib/migrations.ts";

function run(repoRoot: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function output(repoRoot: string, args: ReadonlyArray<string>): string {
  const result = run(repoRoot, args);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args[0] ?? "command"} failed.`);
  }
  return result.stdout;
}

/** Reads migration files from a local repository whose refs include the fork and upstream. */
export function makeUpstreamMigrationGit(repoRoot: string, worktree = false): UpstreamMigrationGit {
  return {
    show: (revision, path) => {
      if (worktree && revision === "WORKTREE") {
        const file = NodePath.join(repoRoot, path);
        return NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : null;
      }
      const result = run(repoRoot, ["show", `${revision}:${path}`]);
      return result.status === 0 ? result.stdout : null;
    },
    blobs: (revision, paths) => {
      const blobs = new Map<string, string>();
      if (worktree && revision === "WORKTREE") {
        for (const path of output(repoRoot, [
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
          "--",
          ...paths,
        ])
          .split("\0")
          .filter(Boolean)) {
          if (NodeFS.existsSync(NodePath.join(repoRoot, path))) {
            blobs.set(path, output(repoRoot, ["hash-object", "--", path]).trim());
          }
        }
        return blobs;
      }
      for (const line of output(repoRoot, ["ls-tree", "-r", revision, "--", ...paths]).split(
        "\n",
      )) {
        const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/u.exec(line);
        if (match) blobs.set(match[2]!, match[1]!);
      }
      return blobs;
    },
    historyBlobs: (revision, paths) => {
      // One pass over the history: every added or modified blob, per path.
      const blobs = new Map<string, Set<string>>();
      const raw = output(repoRoot, [
        "log",
        "--raw",
        "--no-abbrev",
        "--no-renames",
        "--format=",
        revision,
        "--",
        ...paths,
      ]);
      for (const line of raw.split("\n")) {
        const match = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) [AM]\t(.+)$/u.exec(line);
        if (!match) continue;
        const pathBlobs = blobs.get(match[2]!) ?? new Set<string>();
        pathBlobs.add(match[1]!);
        blobs.set(match[2]!, pathBlobs);
      }
      return blobs;
    },
  };
}
