// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from "node:child_process";

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
export function makeUpstreamMigrationGit(repoRoot: string): UpstreamMigrationGit {
  return {
    show: (revision, path) => {
      const result = run(repoRoot, ["show", `${revision}:${path}`]);
      return result.status === 0 ? result.stdout : null;
    },
    blobs: (revision, paths) => {
      const blobs = new Map<string, string>();
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
