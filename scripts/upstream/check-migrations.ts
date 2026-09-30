#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { checkUpstreamMigrationsAtRevision } from "./lib/migrations.ts";
import { makeUpstreamMigrationGit } from "./migration-git.ts";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function resolveCommit(revision: string): string | null {
  const result = NodeChildProcess.spawnSync(
    "git",
    ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

try {
  const ref = option("--ref", "HEAD");
  const upstreamRef = option("--upstream-ref", "refs/remotes/upstream/main");
  const revision = resolveCommit(ref);
  if (revision === null) throw new Error(`${ref} is not a commit.`);
  const upstreamRevision = resolveCommit(upstreamRef);
  if (upstreamRevision === null) {
    throw new Error(
      `${upstreamRef} is not available. Fetch upstream first:\n  git fetch --no-tags https://github.com/pingdotgg/t3code.git main:refs/remotes/upstream/main`,
    );
  }
  const errors = checkUpstreamMigrationsAtRevision({
    git: makeUpstreamMigrationGit(repoRoot),
    revision,
    upstreamRevision,
  });
  for (const error of errors) {
    process.stdout.write(`::error title=Upstream migration history::${error}\n`);
  }
  if (errors.length > 0) {
    process.stdout.write(
      "\nThe upstream migration manifest and files must match upstream. See docs/internals/fork-migrations.md.\n",
    );
    process.exitCode = 1;
  } else {
    process.stdout.write("Upstream migration history matches upstream.\n");
  }
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
}
