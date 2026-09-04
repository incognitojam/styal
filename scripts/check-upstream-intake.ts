#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  decodeForkFeatureLedger,
  ledgerRelativePath,
  validateForkFeatureLedger,
} from "./fork-feature-ledger.ts";
import { auditUpstreamIntakeCandidate } from "./upstream-intake.ts";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

function flag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index === -1 || value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function git(args: ReadonlyArray<string>): string {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args[0] ?? "command"} failed.`);
  }
  return result.stdout.trim();
}

function lines(value: string): ReadonlyArray<string> {
  return value.length === 0 ? [] : value.split(/\r?\n/u);
}

function isAncestor(baseSha: string, headSha: string): boolean {
  const result = NodeChildProcess.spawnSync(
    "git",
    ["merge-base", "--is-ancestor", baseSha, headSha],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(result.stderr.trim() || "Could not compare main with the intake candidate.");
}

function isFileAtRevision(revision: string, path: string): boolean {
  const result = NodeChildProcess.spawnSync("git", ["cat-file", "-t", `${revision}:${path}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === "blob";
}

function writeOutput(name: string, value: string | boolean): void {
  if (process.env.GITHUB_OUTPUT !== undefined) {
    NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value)}\n`);
  }
}

try {
  const baseSha = git(["rev-parse", "--verify", `${flag("--base")}^{commit}`]);
  const headSha = git(["rev-parse", "--verify", `${flag("--head")}^{commit}`]);
  // Use main's ledger as the review policy. A candidate must not be able to
  // weaken the overlap gate by editing or removing its own watched paths.
  const ledger = decodeForkFeatureLedger(git(["show", `${baseSha}:${ledgerRelativePath}`]));
  const ledgerErrors = validateForkFeatureLedger(ledger, repoRoot, {
    isFile: (path) => isFileAtRevision(baseSha, path),
  });
  if (ledgerErrors.length > 0) throw new Error(ledgerErrors.join("\n"));

  const audit = auditUpstreamIntakeCandidate({
    baseSha,
    headSha,
    commits: lines(git(["rev-list", "--reverse", `${baseSha}..${headSha}`])),
    mergeCommits: lines(
      git(["rev-list", "--min-parents=2", "--reverse", `${baseSha}..${headSha}`]),
    ),
    mainIsAncestor: isAncestor(baseSha, headSha),
    changedPaths: lines(git(["diff", "--name-only", "--no-renames", `${baseSha}...${headSha}`])),
    ledger,
  });

  process.stdout.write(audit.summary);
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    NodeFS.appendFileSync(process.env.GITHUB_STEP_SUMMARY, audit.summary);
  }
  writeOutput("valid", audit.valid);
  writeOutput("automatic_eligible", audit.automaticEligible);
  writeOutput("base_sha", baseSha);
  writeOutput("head_sha", headSha);
  for (const error of audit.errors) {
    process.stdout.write(`::error title=Invalid upstream intake candidate::${error}\n`);
  }
  for (const reason of audit.manualReviewReasons) {
    process.stdout.write(`::notice title=Manual upstream intake review required::${reason}\n`);
  }
  if (!audit.valid) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
}
