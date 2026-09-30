#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  decodeForkFeatureLedger,
  findForkFeatureOverlaps,
  type ForkFeatureLedger,
  ledgerRelativePath,
  validateForkFeatureLedger,
} from "../fork-feature-ledger.ts";
import {
  cherryPickSources,
  type CommitReview,
  compareWithUpstream,
  forkAdaptationNote,
} from "./lib/commit-review.ts";
import {
  auditUpstreamIntakeCandidate,
  formatForkCiWatchCommand,
  formatUpstreamIntakePromotionCommand,
  formatUpstreamIntakePushCommand,
} from "./lib/intake.ts";
import {
  changedUpstreamMigrations,
  checkUpstreamMigrationsAtRevision,
  parseUpstreamMigrationManifest,
  upstreamMigrationManifestPath,
} from "./lib/migrations.ts";
import { parseUpstreamProvenance } from "./lib/provenance.ts";
import { makeUpstreamMigrationGit } from "./migration-git.ts";
import { fetchAssociations } from "./queue.ts";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);

function flag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index === -1 || value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function optionalFlag(name: string): string | undefined {
  return process.argv.includes(name) ? flag(name) : undefined;
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

/** Validates the candidate's own ledger, as Fork CI's ledger check would. */
function candidateLedgerReview(headSha: string): ReadonlyArray<string> {
  try {
    const candidate = decodeForkFeatureLedger(git(["show", `${headSha}:${ledgerRelativePath}`]));
    return validateForkFeatureLedger(candidate, repoRoot, {
      isFile: (path) => isFileAtRevision(headSha, path),
    }).map((error) => `Candidate fork feature ledger: ${error}`);
  } catch (error) {
    return [`Candidate fork feature ledger could not be read: ${String(error)}`];
  }
}

/** Checks the candidate's upstream migration history against fetched upstream. */
function upstreamMigrationReview(input: {
  readonly baseSha: string;
  readonly headSha: string;
  readonly upstreamRef: string;
}): { readonly errors: ReadonlyArray<string>; readonly changes: ReadonlyArray<string> } {
  const migrationGit = makeUpstreamMigrationGit(repoRoot);
  const manifestAt = (revision: string) =>
    parseUpstreamMigrationManifest(
      migrationGit.show(revision, upstreamMigrationManifestPath) ?? "",
    );
  const changes = changedUpstreamMigrations({
    base: manifestAt(input.baseSha),
    head: manifestAt(input.headSha),
  });
  const upstream = NodeChildProcess.spawnSync(
    "git",
    ["rev-parse", "--verify", "--quiet", `${input.upstreamRef}^{commit}`],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (upstream.status !== 0) {
    return {
      errors: [
        `${input.upstreamRef} is not available, so the upstream migration history was not checked. Fetch it with: git fetch --no-tags https://github.com/pingdotgg/t3code.git main:refs/remotes/upstream/main`,
      ],
      changes,
    };
  }
  return {
    errors: checkUpstreamMigrationsAtRevision({
      git: migrationGit,
      revision: input.headSha,
      upstreamRevision: upstream.stdout.trim(),
    }),
    changes,
  };
}

function commitExists(sha: string): boolean {
  return (
    NodeChildProcess.spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
    }).status === 0
  );
}

function patch(sha: string): string {
  const result = NodeChildProcess.spawnSync(
    "git",
    ["diff", "--no-color", "--no-renames", "--no-ext-diff", "-U0", `${sha}^`, sha],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git diff ${sha} failed.`);
  return result.stdout;
}

/** A diff between two lists of changed lines, keeping one line of context. */
function interdiff(
  scratch: string,
  upstreamLines: ReadonlyArray<string>,
  forkLines: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const upstreamFile = NodePath.join(scratch, "upstream");
  const forkFile = NodePath.join(scratch, "fork");
  NodeFS.writeFileSync(upstreamFile, `${upstreamLines.join("\n")}\n`);
  NodeFS.writeFileSync(forkFile, `${forkLines.join("\n")}\n`);
  const result = NodeChildProcess.spawnSync(
    "git",
    ["diff", "--no-index", "--no-color", "--no-ext-diff", "-U1", upstreamFile, forkFile],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr.trim() || "git diff --no-index failed.");
  }
  return lines(result.stdout.trimEnd()).flatMap((line) =>
    /^(diff --git|index |--- |\+\+\+ )/u.test(line) ? [] : line.startsWith("@@") ? ["…"] : [line],
  );
}

/** Compares each candidate commit with the upstream commits it imports. */
function reviewCommits(input: {
  readonly commits: ReadonlyArray<string>;
  readonly commitMessages: ReadonlyArray<string>;
  readonly ledger: ForkFeatureLedger;
  readonly scratch: string;
}): ReadonlyArray<CommitReview> {
  return input.commits.map((sha, index) => {
    const message = input.commitMessages[index] ?? "";
    const provenance = parseUpstreamProvenance([message]);
    const sourceCommits = [...new Set([...cherryPickSources(message), ...provenance.commitShas])];
    const paths = lines(git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]));
    const featureIds = findForkFeatureOverlaps(input.ledger, paths).map(
      ({ feature }) => feature.id,
    );
    const missing = sourceCommits.filter((source) => !commitExists(source));
    const comparison: CommitReview["comparison"] =
      paths.length === 0
        ? { status: "provenance-only" }
        : sourceCommits.length === 0
          ? { status: "unavailable", reason: "no cherry-picked or Upstream-Commit source." }
          : missing.length > 0
            ? {
                status: "unavailable",
                reason: `upstream ${missing.map((source) => source.slice(0, 10)).join(", ")} not fetched.`,
              }
            : (() => {
                const files = compareWithUpstream({
                  upstreamPatches: sourceCommits.map(patch),
                  forkPatch: patch(sha),
                }).map((file) => ({
                  ...file,
                  interdiff: interdiff(input.scratch, file.upstreamLines, file.forkLines),
                }));
                return files.length === 0
                  ? { status: "matches" as const }
                  : { status: "adapted" as const, files };
              })();
    return {
      sha,
      subject: message.split(/\r?\n/u)[0] ?? sha,
      pullRequestNumbers: provenance.pullRequestNumbers,
      sourceCommits,
      listedCommits: provenance.commitShas,
      adaptationNote: forkAdaptationNote(message),
      comparison,
      featureIds,
    };
  });
}

function withScratchDirectory<A>(use: (directory: string) => A): A {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "styal-intake-review-"));
  try {
    return use(directory);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

function writeOutput(name: string, value: string | boolean): void {
  if (process.env.GITHUB_OUTPUT !== undefined) {
    NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value)}\n`);
  }
}

/** Look up upstream PRs only for SHAs listed next to Upstream-PR; other trailers need no network. */
function upstreamCommitPullRequests(
  repository: string,
  commitMessages: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlyArray<number>> {
  const shas = new Set(
    commitMessages.flatMap((message) => {
      const source = parseUpstreamProvenance([message]);
      return source.pullRequestNumbers.length === 0 ? [] : source.commitShas;
    }),
  );
  const associations = fetchAssociations(
    [...shas].map((sha) => ({ sha })),
    repository,
    {},
    (command, args) =>
      NodeChildProcess.execFileSync(command, args, { cwd: repoRoot, encoding: "utf8" }),
  );
  return new Map(
    Object.entries(associations).map(([sha, prs]) => [
      sha,
      prs.filter((pr) => pr.baseRepository.nameWithOwner === repository).map((pr) => pr.number),
    ]),
  );
}

interface ForkCiRun {
  readonly databaseId: number;
  readonly status: string;
  readonly conclusion: string;
  readonly url: string;
}

function isForkCiRun(value: unknown): value is ForkCiRun {
  if (typeof value !== "object" || value === null) return false;
  return (
    "databaseId" in value &&
    typeof value.databaseId === "number" &&
    "status" in value &&
    typeof value.status === "string" &&
    "conclusion" in value &&
    typeof value.conclusion === "string" &&
    "url" in value &&
    typeof value.url === "string"
  );
}

function remoteBranchSha(branch: string): string | undefined {
  const result = NodeChildProcess.spawnSync(
    "git",
    ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status === 2) return undefined;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Could not inspect the remote intake branch.");
  }
  return result.stdout.trim().split(/\s+/u)[0];
}

function forkCiRuns(repository: string, branch: string, sha: string): ReadonlyArray<ForkCiRun> {
  const result = NodeChildProcess.spawnSync(
    "gh",
    [
      "run",
      "list",
      "--repo",
      repository,
      "--workflow",
      "fork-ci.yml",
      "--branch",
      branch,
      "--commit",
      sha,
      "--event",
      "push",
      "--limit",
      "20",
      "--json",
      "databaseId,status,conclusion,url",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Could not inspect Fork CI.");
  }
  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || !parsed.every(isForkCiRun)) {
    throw new Error("GitHub returned an unexpected Fork CI response.");
  }
  return parsed;
}

function printPromotionReadiness(input: {
  readonly repository: string;
  readonly candidateBranch: string;
  readonly candidateSha: string;
}): void {
  const remoteSha = remoteBranchSha(input.candidateBranch);
  if (remoteSha !== input.candidateSha) {
    const state = remoteSha === undefined ? "is not pushed" : `points at ${remoteSha}`;
    process.stdout.write(
      `\nRemote branch ${state}. Push the audited candidate, then rerun this audit:\n\n${formatUpstreamIntakePushCommand(
        {
          candidateBranch: input.candidateBranch,
          ...(remoteSha === undefined ? {} : { remoteSha }),
        },
      )}\n`,
    );
    return;
  }

  const runs = forkCiRuns(input.repository, input.candidateBranch, input.candidateSha);
  const successful = runs.find((run) => run.status === "completed" && run.conclusion === "success");
  if (successful !== undefined) {
    process.stdout.write(
      `\nFork CI passed: ${successful.url}\n\nPromotion command:\n\n${formatUpstreamIntakePromotionCommand(
        input,
      )}\n`,
    );
    return;
  }

  const active = runs.find((run) => run.status !== "completed");
  if (active !== undefined) {
    process.stdout.write(
      `\nFork CI is ${active.status}: ${active.url}\n\nWait for it to finish, then rerun this audit:\n\n${formatForkCiWatchCommand(
        { repository: input.repository, runId: active.databaseId },
      )}\n`,
    );
    return;
  }

  const latest = runs[0];
  if (latest !== undefined) {
    process.stdout.write(
      `\nFork CI did not pass (${latest.conclusion || latest.status}): ${latest.url}\nResolve or rerun Fork CI, then rerun this audit.\n`,
    );
    return;
  }

  process.stdout.write(
    "\nThe remote candidate is current, but Fork CI has not appeared yet. Wait for it to start, then rerun this audit.\n",
  );
}

try {
  const baseSha = git(["rev-parse", "--verify", `${flag("--base")}^{commit}`]);
  const headRef = flag("--head");
  const headSha = git(["rev-parse", "--verify", `${headRef}^{commit}`]);
  // Use main's ledger as the review policy. A candidate must not be able to
  // weaken the overlap gate by editing or removing its own watched paths.
  const ledger = decodeForkFeatureLedger(git(["show", `${baseSha}:${ledgerRelativePath}`]));
  const ledgerErrors = validateForkFeatureLedger(ledger, repoRoot, {
    isFile: (path) => isFileAtRevision(baseSha, path),
  });
  if (ledgerErrors.length > 0) throw new Error(ledgerErrors.join("\n"));

  const candidateLedgerErrors = candidateLedgerReview(headSha);
  const migrations = upstreamMigrationReview({
    baseSha,
    headSha,
    upstreamRef: optionalFlag("--upstream-ref") ?? "refs/remotes/upstream/main",
  });
  const commits = lines(git(["rev-list", "--reverse", `${baseSha}..${headSha}`]));
  const commitMessages = commits.map((commit) => git(["show", "-s", "--format=%B", commit]));
  const audit = auditUpstreamIntakeCandidate({
    baseSha,
    headSha,
    commits,
    commitMessages,
    mergeCommits: lines(
      git(["rev-list", "--min-parents=2", "--reverse", `${baseSha}..${headSha}`]),
    ),
    mainIsAncestor: isAncestor(baseSha, headSha),
    changedPaths: lines(git(["diff", "--name-only", "--no-renames", `${baseSha}...${headSha}`])),
    ledger,
    commitPullRequests: upstreamCommitPullRequests(ledger.upstream_repository, commitMessages),
    candidateLedgerErrors,
    migrationErrors: migrations.errors,
    migrationChanges: migrations.changes,
    commitReviews: withScratchDirectory((scratch) =>
      reviewCommits({ commits, commitMessages, ledger, scratch }),
    ),
  });

  process.stdout.write(audit.summary);
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    NodeFS.appendFileSync(process.env.GITHUB_STEP_SUMMARY, audit.summary);
  }
  writeOutput("valid", audit.valid);
  writeOutput("automatic_eligible", audit.automaticEligible);
  writeOutput("base_sha", baseSha);
  writeOutput("head_sha", headSha);
  writeOutput("source_prs", audit.sourcePullRequests.join(","));
  writeOutput("source_commits", audit.sourceCommits.join(","));
  for (const error of audit.errors) {
    process.stdout.write(`::error title=Invalid upstream intake candidate::${error}\n`);
  }
  for (const reason of audit.manualReviewReasons) {
    process.stdout.write(`::notice title=Manual upstream intake review required::${reason}\n`);
  }
  const candidateBranch = headRef.startsWith("refs/heads/")
    ? headRef.slice("refs/heads/".length)
    : headRef.startsWith("origin/")
      ? headRef.slice("origin/".length)
      : headRef;
  if (audit.valid && candidateBranch.startsWith("intake/")) {
    try {
      printPromotionReadiness({
        repository: ledger.fork_repository,
        candidateBranch,
        candidateSha: headSha,
      });
    } catch (error) {
      process.stderr.write(`Could not inspect promotion readiness: ${String(error)}\n`);
    }
  }
  if (!audit.valid) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
}
