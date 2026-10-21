#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

/**
 * Applies upstream commits to an intake branch, resolving the conflicts that follow from known
 * fork differences and stopping on the rest. See docs/operations/upstream-tracking.md.
 *
 *   intake-run.ts apply (--count <n> | --through <upstream-sha> | --commits <sha,...>) [--branch <name>]
 *   intake-run.ts continue [--note <text>] [--feature <id,id>]
 *   intake-run.ts auto --branch <name> [--max <n>] [--push] [--no-rerere]
 *   intake-run.ts push
 *   intake-run.ts survey [--base HEAD] [--count 100 | --through <sha>] [--json]
 *   intake-run.ts fix-trailers [--base origin/main]
 *   intake-run.ts fix-references [--base origin/main]
 *   intake-run.ts verify [--base origin/main] [--all-tests]
 *   intake-run.ts replay <promoted-candidate-sha> [--base <fork-sha>] [--skip-lockfile] [--json] [--dump <dir>]
 *   intake-run.ts score <dump-dir> [--exclude <sha-prefixes>] [--verbose]
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  changedLinesByFile,
  cherryPickSources,
  compareWithUpstream,
  forkAdaptationNote,
  preservedFeatureIds,
} from "./lib/commit-review.ts";
import {
  type HunkResolution,
  parseConflictFile,
  renderConflictFile,
  resolveHunk,
} from "./lib/conflicts.ts";
import { parseUpstreamProvenance } from "./lib/provenance.ts";
import {
  namespaceAlias,
  parseReferenceErrors,
  relativeSpecifier,
  renameIdentifier,
  useNamespaceImport,
} from "./lib/references.ts";
import { applyIdentifierRenames, deriveIdentifierRenames } from "./lib/renames.ts";
import { holdForPushedCandidate } from "./landing-hold.ts";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);

// ---------------------------------------------------------------------------------------------
// Process helpers

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
  input?: string,
  env: NodeJS.ProcessEnv = process.env,
): Run {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    input,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...env, GIT_EDITOR: "true" },
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function git(cwd: string, args: ReadonlyArray<string>, input?: string): string {
  let result = run(cwd, "git", args, input);
  // A styal server polling this checkout's status can hold the index lock for a moment.
  for (
    let attempt = 0;
    attempt < 20 && /index\.lock': File exists/u.test(result.stderr);
    attempt += 1
  ) {
    sleep(250);
    result = run(cwd, "git", args, input);
  }
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
}

const lines = (text: string) => text.split("\n").filter((line) => line.length > 0);

function sleep(milliseconds: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// ---------------------------------------------------------------------------------------------
// One upstream commit

export type AdaptationKind =
  | "rerere"
  | "identity"
  | "upstream-rename"
  | "additions"
  | "fork-deletion"
  | "lockfile"
  | "service-keys"
  | "ledger-paths";

export interface Adaptation {
  readonly kind: AdaptationKind;
  readonly path: string;
  readonly detail?: string;
}

export interface PickOutcome {
  readonly upstreamSha: string;
  /** "clean": applied without conflicts; "resolved": every conflict resolved here. */
  readonly status: "clean" | "resolved" | "stopped";
  readonly adaptations: ReadonlyArray<Adaptation>;
  /** Files still holding conflicts, with the number of unresolved hunks in each. */
  readonly unresolved: ReadonlyArray<{ readonly path: string; readonly hunks: number }>;
  /** Added lines naming upstream's product in agent-facing code, for review. */
  readonly identityReview: ReadonlyArray<string>;
  readonly lockfile?: LockfileReport;
}

export interface LockfileReport {
  /** Versions upstream's lockfile adds that the regenerated lockfile still lacks. */
  readonly missing: ReadonlyArray<string>;
  /** Versions upstream's lockfile drops that the regenerated lockfile still has. */
  readonly stale: ReadonlyArray<string>;
  readonly pinned: ReadonlyArray<string>;
}

const LOCKFILE = "pnpm-lock.yaml";
/** Files pnpm reads to resolve the lockfile. */
const MANIFEST = /(^|\/)package\.json$|^pnpm-workspace\.yaml$/u;

function unmergedFiles(
  cwd: string,
): ReadonlyArray<{ readonly path: string; readonly code: string }> {
  return lines(git(cwd, ["status", "--porcelain=v1", "-z"]).replaceAll("\0", "\n"))
    .map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }))
    .filter(({ code }) => ["UU", "AA", "DU", "UD", "AU", "UA", "DD"].includes(code));
}

/** Resolves what it can in one conflicted text file, writing the result back. */
/**
 * Merges one file again after giving the fork's version and the base the renames upstream's
 * commit makes in that file, so a mechanical rename stops conflicting with fork edits nearby.
 * Returns the merged text with any remaining hunks resolved where possible, or null when the
 * commit renames nothing in the file or a version is missing.
 */
function remergeWithRenames(
  cwd: string,
  upstreamSha: string,
  path: string,
): { readonly text: string; readonly unresolved: number; readonly renames: number } | null {
  const renames = deriveIdentifierRenames(
    git(cwd, ["diff", "-U0", "--no-renames", `${upstreamSha}^`, upstreamSha, "--", path]),
  );
  if (renames.size === 0) return null;
  const show = (ref: string) => run(cwd, "git", ["show", `${ref}:${path}`]);
  const ours = show("HEAD");
  const base = show(`${upstreamSha}^`);
  const theirs = show(upstreamSha);
  if (ours.status !== 0 || base.status !== 0 || theirs.status !== 0) return null;
  const directory = NodePath.join(
    git(cwd, ["rev-parse", "--absolute-git-dir"]).trim(),
    "intake-run-merge",
  );
  NodeFS.mkdirSync(directory, { recursive: true });
  const write = (name: string, text: string) => {
    const file = NodePath.join(directory, name);
    NodeFS.writeFileSync(file, text);
    return file;
  };
  const merged = run(cwd, "git", [
    "merge-file",
    "--diff3",
    "-p",
    "-L",
    "HEAD",
    "-L",
    "base",
    "-L",
    "upstream",
    write("ours", applyIdentifierRenames(ours.stdout, renames)),
    write("base", applyIdentifierRenames(base.stdout, renames)),
    write("theirs", theirs.stdout),
  ]);
  // merge-file exits with the number of conflicts, or above 127 when it fails.
  if (merged.status > 127) return null;
  const parsed = parseConflictFile(merged.stdout);
  if (parsed === null) return null;
  const resolutions = parsed.hunks.map((hunk) => resolveHunk(hunk, path));
  return {
    text: renderConflictFile(
      parsed,
      resolutions.map((resolution) => (resolution.kind === "unresolved" ? null : resolution.text)),
    ),
    unresolved: resolutions.filter((resolution) => resolution.kind === "unresolved").length,
    renames: renames.size,
  };
}

/** Set by `replay --dump` to collect every conflict hunk with how it was resolved. */
let hunkSink: Array<{ path: string; hunk: unknown; resolution: string }> | null = null;

function resolveFile(
  cwd: string,
  path: string,
): { readonly resolutions: ReadonlyArray<HunkResolution>; readonly unresolved: number } | null {
  const absolute = NodePath.join(cwd, path);
  const bytes = NodeFS.readFileSync(absolute);
  // Binary conflicts carry no markers; leave them for a person to choose a side.
  if (bytes.includes(0)) return null;
  const parsed = parseConflictFile(bytes.toString("utf8"));
  if (parsed === null || parsed.hunks.length === 0) return null;
  if (hunkSink) {
    for (const hunk of parsed.hunks)
      hunkSink.push({ path, hunk, resolution: resolveHunk(hunk, path).kind });
  }
  const resolutions = parsed.hunks.map((hunk) => resolveHunk(hunk, path));
  NodeFS.writeFileSync(
    absolute,
    renderConflictFile(
      parsed,
      resolutions.map((resolution) => (resolution.kind === "unresolved" ? null : resolution.text)),
    ),
  );
  return {
    resolutions,
    unresolved: resolutions.filter((resolution) => resolution.kind === "unresolved").length,
  };
}

/** Package versions a lockfile resolves, as `name@version` without peer suffixes. */
export function lockfilePackages(text: string): ReadonlySet<string> {
  const packages = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^ {2}'?((?:@[^@/\s]+\/)?[^@\s']+@[0-9][^:(\s']*)/u.exec(line);
    if (match && line.trimEnd().endsWith(":")) packages.add(match[1]!);
  }
  return packages;
}

function splitPackage(entry: string): { readonly name: string; readonly version: string } {
  const at = entry.lastIndexOf("@");
  return { name: entry.slice(0, at), version: entry.slice(at + 1) };
}

/** An override selector for the major line of `version`, or the bare name for 0.x versions. */
export function overrideSelector(name: string, version: string): string {
  const major = Number.parseInt(version, 10);
  return major > 0 ? `${name}@^${major}.0.0` : name;
}

function compareLockfiles(
  cwd: string,
  upstreamSha: string,
): { missing: Array<string>; stale: Array<string> } {
  const after = lockfilePackages(git(cwd, ["show", `${upstreamSha}:${LOCKFILE}`]));
  const before = lockfilePackages(git(cwd, ["show", `${upstreamSha}^:${LOCKFILE}`]));
  const ours = lockfilePackages(NodeFS.readFileSync(NodePath.join(cwd, LOCKFILE), "utf8"));
  return {
    missing: [...after].filter((entry) => !before.has(entry) && !ours.has(entry)).toSorted(),
    stale: [...before].filter((entry) => !after.has(entry) && ours.has(entry)).toSorted(),
  };
}

/**
 * Regenerates the fork's lockfile, then pins any version upstream's lockfile adds but the fresh
 * resolution chose differently, using temporary overrides that the lockfile keeps once removed.
 */
function regenerateLockfile(cwd: string, upstreamSha: string): LockfileReport {
  const install = () => {
    const result = run(cwd, "pnpm", ["install", "--lockfile-only", "--ignore-scripts"]);
    if (result.status !== 0)
      throw new Error(`pnpm install --lockfile-only failed:\n${result.stderr}`);
  };
  install();
  const first = compareLockfiles(cwd, upstreamSha);
  const pinned: Array<string> = [];
  if (first.missing.length > 0 || first.stale.length > 0) {
    const workspacePath = NodePath.join(cwd, "pnpm-workspace.yaml");
    const workspace = NodeFS.readFileSync(workspacePath, "utf8");
    const overrides = new Map<string, string>();
    const ambiguous = new Set<string>();
    const upstreamAfter = lockfilePackages(git(cwd, ["show", `${upstreamSha}:${LOCKFILE}`]));
    for (const entry of first.missing) {
      const { name, version } = splitPackage(entry);
      const selector = overrideSelector(name, version);
      // A selector shared by two missing versions, or by another version upstream keeps,
      // would move more than the one package it pins.
      const keeps = [...upstreamAfter].some((other) => {
        const kept = splitPackage(other);
        return (
          kept.name === name &&
          kept.version !== version &&
          overrideSelector(name, kept.version) === selector
        );
      });
      if (keeps || overrides.has(selector)) ambiguous.add(selector);
      else overrides.set(selector, version);
    }
    for (const selector of ambiguous) overrides.delete(selector);
    const block = [...overrides]
      .map(([selector, version]) => `  ${JSON.stringify(selector)}: ${JSON.stringify(version)}`)
      .join("\n");
    if (overrides.size > 0) {
      NodeFS.writeFileSync(
        workspacePath,
        /^overrides:\n/mu.test(workspace)
          ? workspace.replace(/^overrides:\n/mu, `overrides:\n${block}\n`)
          : `${workspace.replace(/\n*$/u, "")}\n\noverrides:\n${block}\n`,
      );
      try {
        install();
      } finally {
        NodeFS.writeFileSync(workspacePath, workspace);
      }
      install();
      pinned.push(...overrides.keys());
    }
  }
  const last = compareLockfiles(cwd, upstreamSha);
  return { ...last, pinned };
}

/** Packages whose fork name differs from upstream's, so service keys take the fork's prefix. */
function renamedPackages(
  cwd: string,
  upstreamSha: string,
  paths: ReadonlyArray<string>,
): ReadonlyArray<{ readonly directory: string; readonly from: string; readonly to: string }> {
  const directories = new Set(
    paths.flatMap((path) => {
      const match = /^((?:apps|packages|infra)\/[^/]+)\//u.exec(path);
      return match ? [match[1]!] : [];
    }),
  );
  return [...directories].flatMap((directory) => {
    const read = (ref: string | null) => {
      const result =
        ref === null
          ? { status: 0, stdout: readIfExists(NodePath.join(cwd, directory, "package.json")) }
          : run(cwd, "git", ["show", `${ref}:${directory}/package.json`]);
      try {
        return result.status === 0 ? (JSON.parse(result.stdout).name as string) : null;
      } catch {
        return null;
      }
    };
    const from = read(upstreamSha);
    const to = read(null);
    return from && to && from !== to ? [{ directory, from, to }] : [];
  });
}

function readIfExists(path: string): string {
  return NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8") : "";
}

/**
 * Replaces the package prefix of service keys, such as `>()("t3/provider/X")`, including keys
 * the formatter wrapped onto the next line.
 */
export function rewriteServiceKeyText(text: string, from: string, to: string): string {
  return text.replace(new RegExp(`(>\\(\\)\\(\\s*")${escapeRegExp(from)}/`, "gu"), `$1${to}/`);
}

/** Rewrites `Context.Service` keys that carry upstream's package name to the fork's. */
function rewriteServiceKeys(
  cwd: string,
  upstreamSha: string,
  paths: ReadonlyArray<string>,
  skip: ReadonlySet<string> = new Set(),
): ReadonlyArray<Adaptation> {
  const adaptations: Array<Adaptation> = [];
  for (const { directory, from, to } of renamedPackages(cwd, upstreamSha, paths)) {
    for (const path of paths) {
      if (!path.startsWith(`${directory}/`) || !/\.tsx?$/u.test(path) || skip.has(path)) continue;
      const absolute = NodePath.join(cwd, path);
      if (!NodeFS.existsSync(absolute)) continue;
      const text = NodeFS.readFileSync(absolute, "utf8");
      const rewritten = rewriteServiceKeyText(text, from, to);
      if (rewritten !== text) {
        NodeFS.writeFileSync(absolute, rewritten);
        git(cwd, ["add", "--", path]);
        adaptations.push({ kind: "service-keys", path, detail: `${from}/ -> ${to}/` });
      }
    }
  }
  return adaptations;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const LEDGER = ".github/fork-features.yml";

/**
 * Points ledger path entries at the files' new locations and keeps each edited list sorted, as
 * the ledger check requires.
 */
export function moveLedgerPaths(
  text: string,
  moves: ReadonlyMap<string, string>,
): { readonly text: string; readonly moved: number } {
  const lines = text.split("\n");
  let moved = 0;
  const edited = new Set<number>();
  lines.forEach((line, index) => {
    const match = /^(\s*- )(\S+)$/u.exec(line);
    const target = match ? moves.get(match[2]!) : undefined;
    if (match && target !== undefined) {
      lines[index] = `${match[1]}${target}`;
      moved += 1;
      edited.add(index);
    }
  });
  for (const index of edited) {
    const indent = /^(\s*)- /u.exec(lines[index]!)![1]!;
    const item = (line: string | undefined) =>
      line !== undefined &&
      line.startsWith(`${indent}- `) &&
      !line.slice(indent.length + 2).startsWith(" ");
    let start = index;
    while (item(lines[start - 1])) start -= 1;
    let end = index;
    while (item(lines[end + 1])) end += 1;
    lines.splice(start, end - start + 1, ...lines.slice(start, end + 1).toSorted());
  }
  return { text: lines.join("\n"), moved };
}

/**
 * Files merged into a module of the same name in a parent folder, such as
 * `provider/Services/X.ts` into `provider/X.ts`. Git reports these as a deletion and an addition
 * because the new module combines two files.
 */
export function mergedModuleMoves(
  deleted: ReadonlyArray<string>,
  added: ReadonlyArray<string>,
): ReadonlyMap<string, string> {
  const moves = new Map<string, string>();
  for (const from of deleted) {
    const candidates = added.filter(
      (to) =>
        NodePath.posix.basename(to) === NodePath.posix.basename(from) &&
        NodePath.posix.dirname(from).startsWith(`${NodePath.posix.dirname(to)}/`),
    );
    if (candidates.length === 1) moves.set(from, candidates[0]!);
  }
  return moves;
}

/** Moves ledger paths for files this pick renames, including fork files moved with a folder. */
function moveLedgerPathsForStagedRenames(cwd: string): ReadonlyArray<Adaptation> {
  const absolute = NodePath.join(cwd, LEDGER);
  if (!NodeFS.existsSync(absolute)) return [];
  const fields = git(cwd, ["diff", "--cached", "-M", "--name-status", "-z", "HEAD"]).split("\0");
  const moves = new Map<string, string>();
  const deleted: Array<string> = [];
  const added: Array<string> = [];
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index]!;
    if (status.startsWith("R")) {
      moves.set(fields[index + 1]!, fields[index + 2]!);
      // A module that absorbed a second file arrives as a rename of the first.
      added.push(fields[index + 2]!);
      index += 2;
    } else if (status === "D" || status === "A") {
      (status === "D" ? deleted : added).push(fields[index + 1]!);
      index += 1;
    } else if (status !== "") {
      index += 1;
    }
  }
  for (const [from, to] of mergedModuleMoves(deleted, added)) moves.set(from, to);
  if (moves.size === 0) return [];
  const result = moveLedgerPaths(NodeFS.readFileSync(absolute, "utf8"), moves);
  if (result.moved === 0) return [];
  NodeFS.writeFileSync(absolute, result.text);
  git(cwd, ["add", "--", LEDGER]);
  return [{ kind: "ledger-paths", path: LEDGER, detail: String(result.moved) }];
}

/** Code whose strings agents or users read: tool text, instructions, contracts, and client UI. */
const PRODUCT_FACING =
  /^(apps\/server\/src\/(mcp|provider|orchestration-v2)\/|packages\/contracts\/src\/|apps\/(web|mobile|desktop)\/src\/)/u;
const UPSTREAM_PRODUCT = /\bT3 Code\b|\bT3 Connect\b|\bT3 home\b|t3-code MCP server/u;

/** Lines the pick adds that name upstream's product where agents or users read them. */
function identityReview(cwd: string): ReadonlyArray<string> {
  const diff = git(cwd, ["diff", "--cached", "-U0", "HEAD"]);
  const findings: Array<string> = [];
  let path = "";
  for (const line of diff.split("\n")) {
    const header = /^\+\+\+ b\/(.+)$/u.exec(line);
    if (header) {
      path = header[1]!;
      continue;
    }
    if (
      line.startsWith("+") &&
      PRODUCT_FACING.test(path) &&
      !/\.test\.tsx?$/u.test(path) &&
      UPSTREAM_PRODUCT.test(line)
    ) {
      findings.push(`${path}: ${line.slice(1).trim().slice(0, 160)}`);
    }
  }
  return findings;
}

/**
 * Cherry-picks one upstream commit onto the checkout in `cwd` and resolves what it can. The pick
 * is left staged and uncommitted; a stopped pick keeps its conflict markers for review.
 */
export function pickUpstreamCommit(
  cwd: string,
  upstreamSha: string,
  options: { readonly skipLockfile?: boolean; readonly rerere?: boolean } = {},
): PickOutcome {
  const parents = lines(git(cwd, ["rev-list", "--parents", "-n", "1", upstreamSha])).join(" ");
  const isMerge = parents.split(" ").length > 2;
  const picked = run(cwd, "git", [
    "-c",
    "merge.conflictStyle=diff3",
    "-c",
    `rerere.enabled=${options.rerere === false ? "false" : "true"}`,
    "cherry-pick",
    "--no-commit",
    ...(isMerge ? ["-m", "1"] : []),
    upstreamSha,
  ]);
  const adaptations: Array<Adaptation> = [];
  const unresolved: Array<{ path: string; hunks: number }> = [];
  let lockfile: LockfileReport | undefined;
  const conflicts = picked.status === 0 ? [] : unmergedFiles(cwd);
  if (picked.status !== 0 && conflicts.length === 0) {
    throw new Error(`cherry-pick ${upstreamSha} failed: ${picked.stderr.trim()}`);
  }
  // rerere replays a resolution recorded the last time this conflict was resolved by hand.
  const replayed = new Set(
    [
      ...`${picked.stdout}\n${picked.stderr}`.matchAll(
        /Resolved '(.+)' using previous resolution/gu,
      ),
    ].map((match) => match[1]!),
  );
  let lockfileConflict = false;
  for (const { path, code } of conflicts) {
    if (replayed.has(path) && !/^(<{7}|>{7})/mu.test(readIfExists(NodePath.join(cwd, path)))) {
      git(cwd, ["add", "--", path]);
      adaptations.push({ kind: "rerere", path });
      continue;
    }
    if (path === LOCKFILE) {
      if (code !== "UU" && code !== "AA") {
        unresolved.push({ path, hunks: 1 });
        continue;
      }
      lockfileConflict = true;
      git(cwd, ["checkout", "--ours", "--", path]);
      continue;
    }
    if (code === "DU") {
      // The fork removed this file; upstream's edit to it has nowhere to land.
      git(cwd, ["rm", "-q", "--", path]);
      adaptations.push({ kind: "fork-deletion", path });
      continue;
    }
    if (code !== "UU" && code !== "AA") {
      unresolved.push({ path, hunks: 1 });
      continue;
    }
    const result = resolveFile(cwd, path);
    if (result === null) {
      unresolved.push({ path, hunks: 1 });
      continue;
    }
    for (const resolution of result.resolutions) {
      if (resolution.kind === "identity") {
        adaptations.push({
          kind: "identity",
          path,
          detail: resolution.replacements.map(([from, to]) => `${from} -> ${to}`).join(", "),
        });
      } else if (resolution.kind === "upstream-rename") {
        adaptations.push({
          kind: "upstream-rename",
          path,
          detail: resolution.replacements.map(([from, to]) => `${from} -> ${to}`).join(", "),
        });
      } else if (
        resolution.kind === "additions" ||
        resolution.kind === "superset" ||
        resolution.kind === "surrounding-additions"
      ) {
        adaptations.push({ kind: "additions", path });
      }
    }
    let remaining = result.unresolved;
    if (remaining > 0) {
      const remerged = remergeWithRenames(cwd, upstreamSha, path);
      if (remerged !== null && remerged.unresolved < remaining) {
        NodeFS.writeFileSync(NodePath.join(cwd, path), remerged.text);
        remaining = remerged.unresolved;
        adaptations.push({
          kind: "upstream-rename",
          path,
          detail: `merged again with ${remerged.renames} of upstream's renames`,
        });
      }
    }
    if (remaining > 0) unresolved.push({ path, hunks: remaining });
    else git(cwd, ["add", "--", path]);
  }
  // pnpm cannot read a manifest that still holds conflict markers, so the lockfile waits for
  // `continue`, which regenerates it once the manifests are resolved.
  const manifestsPending = unresolved.some((file) => MANIFEST.test(file.path));
  if (lockfileConflict && manifestsPending) {
    unresolved.push({ path: LOCKFILE, hunks: 1 });
  } else if (lockfileConflict) {
    if (options.skipLockfile) {
      // The fork's lockfile stays as it was; regenerate it before validating the batch.
      git(cwd, ["add", "--", LOCKFILE]);
      adaptations.push({ kind: "lockfile", path: LOCKFILE, detail: "skipped" });
    } else {
      lockfile = regenerateLockfile(cwd, upstreamSha);
      git(cwd, ["add", "--", LOCKFILE]);
      adaptations.push({ kind: "lockfile", path: LOCKFILE });
    }
  }
  const changedPaths = lines(
    git(cwd, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      ...(isMerge ? ["-m", "--first-parent"] : []),
      upstreamSha,
    ]),
  );
  adaptations.push(
    ...rewriteServiceKeys(
      cwd,
      upstreamSha,
      changedPaths,
      new Set(unresolved.map((file) => file.path)),
    ),
  );
  if (unresolved.length === 0) adaptations.push(...moveLedgerPathsForStagedRenames(cwd));
  return {
    upstreamSha,
    status: unresolved.length > 0 ? "stopped" : conflicts.length > 0 ? "resolved" : "clean",
    adaptations,
    unresolved,
    identityReview: unresolved.length > 0 ? [] : identityReview(cwd),
    ...(lockfile ? { lockfile } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Commit messages

const AGENT_PATHS =
  /^(apps\/server\/src\/(mcp|provider)\/|apps\/server\/src\/orchestration-v2\/(PullRequestWatchReactor|pullRequestWatch)|packages\/contracts\/src\/orchestratorMcp)/u;

/** A draft `Fork adaptation:` note and features for what the driver changed in a pick. */
export function draftAdaptationNote(
  adaptations: ReadonlyArray<Adaptation>,
  lockfile?: LockfileReport,
): {
  readonly note: string | null;
  readonly features: ReadonlyArray<string>;
} {
  const sentences: Array<string> = [];
  const features = new Set<string>();
  const identity = adaptations.filter((adaptation) => adaptation.kind === "identity");
  if (identity.length > 0) {
    const renames = [
      ...new Set(identity.flatMap((adaptation) => (adaptation.detail ?? "").split(", "))),
    ]
      .filter((rename) => rename !== "")
      .map((rename) => `\`${rename.replace(" -> ", "` to `")}\``);
    const files = [...new Set(identity.map((adaptation) => `\`${adaptation.path}\``))];
    sentences.push(
      `Upstream's new text in ${files.join(", ")} takes the fork's naming (${renames.join(", ")}), as the fork's existing text there does.`,
    );
    features.add(
      identity.some((adaptation) => AGENT_PATHS.test(adaptation.path))
        ? "fork-agent-integration-identity"
        : "fork-distribution-identity",
    );
  }
  const keys = adaptations.filter((adaptation) => adaptation.kind === "service-keys");
  if (keys.length > 0) {
    sentences.push(
      `The new service keys in ${keys.map((adaptation) => `\`${adaptation.path}\``).join(", ")} use the fork's package name.`,
    );
    features.add("fork-distribution-identity");
  }
  if (adaptations.some((adaptation) => adaptation.kind === "ledger-paths")) {
    sentences.push("The fork feature ledger names the moved files' new paths.");
  }
  for (const deletion of adaptations.filter((adaptation) => adaptation.kind === "fork-deletion")) {
    sentences.push(`\`${deletion.path}\` stays absent: the fork does not carry it.`);
  }
  if (lockfile) {
    const differences = [
      ...lockfile.missing.map((entry) => `${entry} is not resolved`),
      ...lockfile.stale.map((entry) => `${entry} is still resolved`),
    ];
    sentences.push(
      differences.length === 0
        ? "The lockfile is regenerated from the fork's dependency graph and resolves the same new versions as upstream's."
        : `The lockfile is regenerated from the fork's dependency graph; unlike upstream's, ${differences.join(", ")}.`,
    );
  }
  return { note: sentences.length === 0 ? null : sentences.join(" "), features: [...features] };
}

export function intakeCommitMessage(input: {
  readonly upstreamMessage: string;
  readonly upstreamSha: string;
  readonly pr: number | null;
  readonly note: string | null;
  readonly features: ReadonlyArray<string>;
}): string {
  const body = input.upstreamMessage.replace(/\s+$/u, "");
  const trailers = [
    `(cherry picked from commit ${input.upstreamSha})`,
    input.pr === null ? `Upstream-Commit: ${input.upstreamSha}` : `Upstream-PR: ${input.pr}`,
    ...(input.features.length > 0 ? [`Fork-Feature: ${input.features.join(", ")}`] : []),
  ].join("\n");
  if (input.note) return `${body}\n\nFork adaptation: ${input.note}\n\n${trailers}\n`;
  // Like `cherry-pick -x`, provenance joins a trailer block that ends upstream's message.
  const lastParagraph = body.split(/\n\n/u).at(-1) ?? "";
  const endsWithTrailers =
    body.includes("\n\n") && lastParagraph.split("\n").every((line) => /^[\w-]+: /u.test(line));
  return `${body}${endsWithTrailers ? "\n" : "\n\n"}${trailers}\n`;
}

function commitPick(
  cwd: string,
  entry: QueueEntry,
  outcome: PickOutcome,
  extra?: { note?: string; features?: ReadonlyArray<string> },
) {
  const draft = draftAdaptationNote(outcome.adaptations, outcome.lockfile);
  const note = [draft.note, extra?.note ?? null].filter((part) => part).join(" ") || null;
  const features = [...new Set([...draft.features, ...(extra?.features ?? [])])];
  const author = lines(git(cwd, ["log", "-1", "--format=%an%n%ae%n%aD", entry.sha]));
  const message = intakeCommitMessage({
    upstreamMessage: git(cwd, ["log", "-1", "--format=%B", entry.sha]),
    upstreamSha: entry.sha,
    pr: entry.pr,
    note,
    features,
  });
  const result = NodeChildProcess.spawnSync(
    "git",
    ["commit", "-q", "--no-verify", "--allow-empty", "-F", "-"],
    {
      cwd,
      input: message,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: author[0],
        GIT_AUTHOR_EMAIL: author[1],
        GIT_AUTHOR_DATE: author[2],
      },
    },
  );
  if (result.status !== 0) throw new Error(`git commit failed: ${result.stderr}`);
  // A no-commit cherry-pick can leave its sequencer state behind.
  run(cwd, "git", ["cherry-pick", "--quit"]);
}

// ---------------------------------------------------------------------------------------------
// Trailers

/**
 * Whether a picked commit changes exactly what its upstream sources change, by the audit's rule:
 * matching changed lines, or each differing file ending identical to upstream's version.
 */
export function commitMatchesUpstream(cwd: string, sha: string): boolean | null {
  const message = git(cwd, ["show", "-s", "--format=%B", sha]);
  const sources = [
    ...new Set([...cherryPickSources(message), ...parseUpstreamProvenance([message]).commitShas]),
  ];
  if (sources.length === 0) return null;
  // The audit diffs against the first parent, so a merge source reads as its first-parent change.
  const patch = (commit: string) =>
    git(cwd, ["diff", "-U0", "--no-renames", `${commit}^1`, commit]);
  const upstreamPatches = sources.map(patch);
  const blob = (commit: string, path: string) =>
    run(cwd, "git", ["rev-parse", "--verify", "--quiet", `${commit}:${path}`]).stdout.trim();
  const differing = compareWithUpstream({ upstreamPatches, forkPatch: patch(sha) }).filter(
    (file) => {
      const last = upstreamPatches.findLastIndex((source) =>
        changedLinesByFile([source]).has(file.path),
      );
      return last === -1 || blob(sha, file.path) !== blob(sources[last]!, file.path);
    },
  );
  return differing.length === 0;
}

export interface TrailerFix {
  readonly sha: string;
  readonly subject: string;
  readonly action: "removed-features" | "needs-note" | "ok";
}

/** Drops `Fork-Feature` from commits that match upstream and lists differing ones without a note. */
function fixTrailers(cwd: string, base: string): ReadonlyArray<TrailerFix> {
  const commits = lines(git(cwd, ["rev-list", "--reverse", `${base}..HEAD`]));
  const plan = commits.map((sha) => {
    const message = git(cwd, ["show", "-s", "--format=%B", sha]);
    const subject = message.split("\n")[0] ?? sha;
    const matches = commitMatchesUpstream(cwd, sha);
    if (matches === true && preservedFeatureIds(message).length > 0) {
      return { sha, subject, action: "removed-features" as const };
    }
    if (matches === false && forkAdaptationNote(message) === null) {
      return { sha, subject, action: "needs-note" as const };
    }
    return { sha, subject, action: "ok" as const };
  });
  if (plan.some((fix) => fix.action === "removed-features")) {
    // Rebuild the branch, rewriting only the messages that cite features they do not preserve.
    const remove = new Set(
      plan.filter((fix) => fix.action === "removed-features").map((fix) => fix.sha),
    );
    requireCleanIndex(cwd);
    const branch = git(cwd, ["symbolic-ref", "--short", "HEAD"]).trim();
    git(cwd, ["checkout", "-q", "--detach", commits[0] ? `${commits[0]}^` : base]);
    try {
      for (const sha of commits) {
        git(cwd, ["cherry-pick", "--allow-empty", "--keep-redundant-commits", sha]);
        if (remove.has(sha)) {
          const message = git(cwd, ["show", "-s", "--format=%B", "HEAD"])
            .split("\n")
            .filter((line) => !line.startsWith("Fork-Feature:"))
            .join("\n");
          git(cwd, ["commit", "-q", "--amend", "--no-verify", "-F", "-"], message);
        }
      }
    } catch (error) {
      // The branch itself is untouched until the rebuild finishes; return to it.
      run(cwd, "git", ["cherry-pick", "--abort"]);
      git(cwd, ["switch", "-q", "--discard-changes", branch]);
      throw error;
    }
    git(cwd, ["switch", "-q", "-C", branch]);
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Queue and state

export interface QueueEntry {
  readonly sha: string;
  readonly pr: number | null;
  readonly title: string;
}

function queueEntries(
  cwd: string,
  selection: { count?: number; through?: string; forkRef?: string },
): ReadonlyArray<QueueEntry> {
  const count = selection.count ?? 200;
  const result = run(cwd, "node", [
    "scripts/upstream/queue.ts",
    "next",
    "--count",
    String(count),
    "--json",
    ...(selection.forkRef === undefined ? [] : ["--fork-ref", selection.forkRef]),
  ]);
  if (result.status !== 0) throw new Error(`queue next failed: ${result.stderr}`);
  const entries = (
    JSON.parse(result.stdout).entries as Array<{
      sha: string;
      pr: number | null;
      title: string;
      disposition: string;
    }>
  )
    .filter((entry) => entry.disposition === "pending")
    .map(({ sha, pr, title }) => ({ sha, pr, title }));
  if (selection.through === undefined) return entries;
  const through = git(cwd, ["rev-parse", selection.through]).trim();
  const end = entries.findIndex((entry) => entry.sha === through);
  if (end === -1)
    throw new Error(`${selection.through} is not among the next ${count} pending commits.`);
  return entries.slice(0, end + 1);
}

/** Upstream commits named directly, with the PR their subject cites. */
function explicitEntries(cwd: string, commits: ReadonlyArray<string>): ReadonlyArray<QueueEntry> {
  return commits.map((commit) => {
    const sha = git(cwd, ["rev-parse", "--verify", `${commit}^{commit}`]).trim();
    const title = git(cwd, ["log", "-1", "--format=%s", sha]).trim();
    const pr = /\(#(\d+)\)$/u.exec(title);
    return { sha, title, pr: pr ? Number(pr[1]) : null };
  });
}

interface RunState {
  readonly remaining: ReadonlyArray<QueueEntry>;
  readonly current: { readonly entry: QueueEntry; readonly outcome: PickOutcome } | null;
}

function statePath(cwd: string): string {
  return NodePath.join(git(cwd, ["rev-parse", "--absolute-git-dir"]).trim(), "intake-run.json");
}

function saveState(cwd: string, state: RunState | null) {
  const path = statePath(cwd);
  if (state === null) NodeFS.rmSync(path, { force: true });
  else NodeFS.writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function describeOutcome(entry: QueueEntry, outcome: PickOutcome): string {
  const label = `${entry.sha.slice(0, 10)} ${entry.pr === null ? "direct" : `#${entry.pr}`} ${entry.title}`;
  const kinds = [...new Set(outcome.adaptations.map((adaptation) => adaptation.kind))];
  const parts = [`${outcome.status.padEnd(8)} ${label}`];
  if (kinds.length > 0) parts.push(`    adapted: ${kinds.join(", ")}`);
  for (const file of outcome.unresolved)
    parts.push(`    UNRESOLVED ${file.path} (${file.hunks} hunk${file.hunks === 1 ? "" : "s"})`);
  for (const finding of outcome.identityReview) parts.push(`    review naming: ${finding}`);
  const combined = outcome.adaptations.filter((adaptation) => adaptation.kind === "additions");
  for (const path of new Set(combined.map((adaptation) => adaptation.path))) {
    parts.push(`    review combined lines: ${path}`);
  }
  if (
    outcome.lockfile &&
    (outcome.lockfile.missing.length > 0 || outcome.lockfile.stale.length > 0)
  ) {
    parts.push(
      `    lockfile differs: missing ${outcome.lockfile.missing.join(", ") || "none"}; stale ${outcome.lockfile.stale.join(", ") || "none"}`,
    );
  }
  return parts.join("\n");
}

/** Upstream sources already picked onto the branch since `base`. */
function pickedSources(cwd: string, base: string): ReadonlySet<string> {
  return new Set(
    lines(git(cwd, ["log", "--format=%B", `${base}..HEAD`])).flatMap((line) => {
      const match = /^\(cherry picked from commit ([0-9a-f]{40})\)$/u.exec(line);
      return match ? [match[1]!] : [];
    }),
  );
}

function requireCleanIndex(cwd: string) {
  const status = lines(git(cwd, ["status", "--porcelain=v1", "--untracked-files=no"]));
  if (status.length > 0) {
    throw new Error(`Commit or set aside these changes first:\n${status.join("\n")}`);
  }
}

function applyEntries(
  cwd: string,
  entries: ReadonlyArray<QueueEntry>,
  options: { skipLockfile?: boolean; rerere?: boolean },
) {
  requireCleanIndex(cwd);
  const picked = pickedSources(cwd, "origin/main");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (picked.has(entry.sha)) {
      process.stdout.write(`skipped  ${entry.sha.slice(0, 10)} already on this branch\n`);
      continue;
    }
    let outcome: PickOutcome;
    try {
      outcome = pickUpstreamCommit(cwd, entry.sha, options);
    } catch (error) {
      // Keep the rest of the selection so `continue` can resume after a manual fix.
      saveState(cwd, {
        remaining: entries.slice(index + 1),
        current: {
          entry,
          outcome: {
            upstreamSha: entry.sha,
            status: "stopped",
            adaptations: [],
            unresolved: [],
            identityReview: [],
          },
        },
      });
      throw error;
    }
    process.stdout.write(`${describeOutcome(entry, outcome)}\n`);
    if (outcome.status === "stopped") {
      saveState(cwd, { remaining: entries.slice(index + 1), current: { entry, outcome } });
      process.stdout.write(
        "\nResolve the conflicts above, stage them, then run `intake-run.ts continue` with --note and --feature for any fork adaptation.\n",
      );
      return false;
    }
    commitPick(cwd, entry, outcome);
  }
  saveState(cwd, null);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Automatic batches

const DEFAULT_AUTO_MAX = 30;

const CODE_FILE = /\.(ts|tsx|mts|mjs|js)$/u;
// The fork keeps upstream's product name in comments and test titles; strings a person reads are
// what it renames.
const COMMENT_OR_TEST_TITLE = /^\s*(\/\/|\/\*|\*|(it|test|describe)(\.\w+)?\()/u;

/**
 * Whether an added line names upstream's product where the fork renames it: code outside comments
 * and test titles, and the user guides.
 */
export function namesUpstreamProduct(path: string, line: string): boolean {
  if (!UPSTREAM_PRODUCT.test(line)) return false;
  if (CODE_FILE.test(path)) return !COMMENT_OR_TEST_TITLE.test(line);
  return path.startsWith("docs/user/");
}

/** Added lines in the staged pick that name upstream's product where the fork renames it. */
function addedUpstreamNames(cwd: string): ReadonlyArray<string> {
  const diff = git(cwd, ["diff", "--cached", "-U0", "HEAD"]);
  const findings: Array<string> = [];
  let path = "";
  for (const line of diff.split("\n")) {
    const header = /^\+\+\+ b\/(.+)$/u.exec(line);
    if (header) {
      path = header[1]!;
      continue;
    }
    if (line.startsWith("+") && namesUpstreamProduct(path, line.slice(1))) {
      findings.push(`${path}: ${line.slice(1).trim().slice(0, 160)}`);
    }
  }
  return findings;
}

/**
 * Why `auto` hands a pick to a person instead of committing it: anything `apply` would stop on
 * or ask to review, plus upstream's product name in added strings or user guides and a committed pick that
 * differs from upstream without a note explaining why.
 */
export function autoStopReasons(input: {
  readonly outcome: PickOutcome;
  readonly upstreamNames: ReadonlyArray<string>;
  readonly differsWithoutNote: boolean;
}): ReadonlyArray<string> {
  const { outcome } = input;
  const reasons: Array<string> = [];
  for (const file of outcome.unresolved) reasons.push(`unresolved conflict: ${file.path}`);
  const combined = outcome.adaptations.filter((adaptation) => adaptation.kind === "additions");
  for (const path of new Set(combined.map((adaptation) => adaptation.path))) {
    reasons.push(`combined lines to review: ${path}`);
  }
  if (
    outcome.lockfile &&
    (outcome.lockfile.missing.length > 0 || outcome.lockfile.stale.length > 0)
  ) {
    reasons.push("lockfile differs from upstream's");
  }
  for (const finding of new Set([...outcome.identityReview, ...input.upstreamNames])) {
    reasons.push(`upstream naming: ${finding}`);
  }
  if (input.differsWithoutNote) reasons.push("differs from upstream without a fork note");
  return reasons;
}

/**
 * How many of `picked` a batch keeps when the next commit cannot join it: commits of the same
 * pull request as the next one leave with it, so a batch never ends inside a pull request.
 */
export function batchLength(
  picked: ReadonlyArray<{ readonly pr: number | null }>,
  next: { readonly pr: number | null } | undefined,
): number {
  let length = picked.length;
  if (next?.pr == null) return length;
  while (length > 0 && picked[length - 1]!.pr === next.pr) length -= 1;
  return length;
}

/** Waits for the Fork CI runs on `sha`, returning their conclusion, or null after two hours. */
const forkRepository = () => process.env.GH_REPO ?? "incognitojam/styal";

function waitForForkCi(cwd: string, sha: string): string | null {
  const repository = forkRepository();
  for (let attempt = 0; attempt < 120; attempt += 1) {
    sleep(60_000);
    const result = run(cwd, "gh", [
      "api",
      `repos/${repository}/actions/runs?head_sha=${sha}`,
      "--jq",
      '.workflow_runs[] | select(.name == "Fork CI") | "\\(.status) \\(.conclusion)"',
    ]);
    // A SHA pushed to two branches gets a run for each; wait for all of them.
    const runs = lines(result.stdout).map((line) => line.split(" "));
    if (runs.length > 0 && runs.every(([status]) => status === "completed")) {
      return runs.find(([, conclusion]) => conclusion !== "success")?.[1] ?? "success";
    }
  }
  return null;
}

/**
 * Applies the queue until a pick needs a person or `max` commits are in, then finishes the batch:
 * fixes references and trailers, verifies, and with `push` pushes and waits for Fork CI. A pick
 * that needs a person ends the batch before it; when it is the first, it stays staged for
 * `continue`, as `apply` leaves a stop.
 */
function autoBatch(
  cwd: string,
  options: {
    readonly branch: string;
    readonly max: number;
    readonly push: boolean;
    readonly rerere: boolean;
  },
): boolean {
  requireCleanIndex(cwd);
  git(cwd, ["switch", "-q", "-c", options.branch, "--no-track", "origin/main"]);
  const queue = queueEntries(cwd, { count: options.max + 20 });
  const picked: Array<QueueEntry> = [];
  let blocker: { entry: QueueEntry; reasons: ReadonlyArray<string> } | null = null;
  for (let index = 0; index < queue.length; index += 1) {
    const entry = queue[index]!;
    // Past the cap, keep going only to finish the pull request in progress.
    if (picked.length >= options.max && (entry.pr === null || entry.pr !== picked.at(-1)?.pr)) {
      break;
    }
    const outcome = pickUpstreamCommit(cwd, entry.sha, { rerere: options.rerere });
    const upstreamNames = outcome.status === "stopped" ? [] : addedUpstreamNames(cwd);
    let reasons = autoStopReasons({ outcome, upstreamNames, differsWithoutNote: false });
    if (reasons.length === 0) {
      commitPick(cwd, entry, outcome);
      const message = git(cwd, ["show", "-s", "--format=%B", "HEAD"]);
      const differsWithoutNote =
        commitMatchesUpstream(cwd, "HEAD") === false && forkAdaptationNote(message) === null;
      reasons = autoStopReasons({ outcome, upstreamNames, differsWithoutNote });
      if (reasons.length > 0) git(cwd, ["reset", "-q", "--soft", "HEAD~1"]);
    }
    process.stdout.write(`${describeOutcome(entry, outcome)}\n`);
    if (reasons.length === 0) {
      picked.push(entry);
      continue;
    }
    blocker = { entry, reasons };
    const keep = batchLength(picked, entry);
    if (keep === 0) {
      // Nothing can ship before this pick, so leave it for review as `apply` does, with the rest
      // of its pull request queued behind it.
      const rest = queue.slice(index + 1);
      const samePr = entry.pr === null ? 0 : rest.findIndex((next) => next.pr !== entry.pr);
      saveState(cwd, {
        remaining: rest.slice(0, samePr === -1 ? rest.length : samePr),
        current: { entry, outcome },
      });
      process.stdout.write(
        `\nNeeds a person before it can be committed:\n${reasons.map((reason) => `  ${reason}`).join("\n")}\n\nReview it, stage any changes, then run \`intake-run.ts continue\` with --note and --feature as needed.\n`,
      );
      return false;
    }
    run(cwd, "git", ["reset", "-q", "--hard", "HEAD"]);
    run(cwd, "git", ["cherry-pick", "--quit"]);
    if (keep < picked.length) {
      git(cwd, ["reset", "-q", "--hard", `HEAD~${picked.length - keep}`]);
      picked.length = keep;
    }
    break;
  }
  saveState(cwd, null);
  if (picked.length === 0) {
    process.stdout.write("\nNo pending upstream commits.\n");
    return true;
  }
  process.stdout.write(
    `\nBatch: ${picked.length} commit${picked.length === 1 ? "" : "s"}, through ${picked.at(-1)!.sha.slice(0, 10)}.\n`,
  );
  if (blocker) {
    process.stdout.write(
      `Stopped before ${blocker.entry.sha.slice(0, 10)} ${blocker.entry.title}:\n${blocker.reasons.map((reason) => `  ${reason}`).join("\n")}\n`,
    );
  }
  const unresolvedReferences = fixReferences(cwd, "origin/main");
  if (unresolvedReferences.length > 0) {
    process.stdout.write(`\nReferences not fixed:\n${unresolvedReferences.join("\n")}\n`);
    return false;
  }
  const needsNote = fixTrailers(cwd, "origin/main").filter((fix) => fix.action === "needs-note");
  if (needsNote.length > 0) {
    process.stdout.write(
      `\nDiffers from upstream without a note:\n${needsNote.map((fix) => `  ${fix.subject}`).join("\n")}\n`,
    );
    return false;
  }
  process.stdout.write("\n");
  if (!verify(cwd, "origin/main")) return false;
  if (!options.push) {
    process.stdout.write(`\nVerified. Push ${options.branch} and wait for Fork CI.\n`);
    return true;
  }
  return pushCandidate(cwd, options.branch);
}

/**
 * Pushes an intake candidate, holds open pull requests into main while it lands, and waits for
 * Fork CI, after which promotion starts by itself.
 */
function pushCandidate(cwd: string, branch: string): boolean {
  git(cwd, ["push", "-q", "--force-with-lease", "-u", "origin", `HEAD:refs/heads/${branch}`]);
  const sha = git(cwd, ["rev-parse", "HEAD"]).trim();
  process.stdout.write(`\nPushed ${sha}.\n`);
  if (!holdForPushedCandidate(forkRepository(), branch, sha)) {
    process.stdout.write(
      "Fork CI has not started for it; the Intake landing hold workflow holds pull requests once it does.\n",
    );
  }
  process.stdout.write("Waiting for Fork CI.\n");
  const conclusion = waitForForkCi(cwd, sha);
  if (conclusion !== "success") {
    process.stdout.write(`Fork CI: ${conclusion ?? "still running after two hours"}.\n`);
    return false;
  }
  process.stdout.write(
    `Fork CI passed. Promotion started by itself; approve it if it waits: https://github.com/${forkRepository()}/actions/workflows/promote-upstream-intake.yml\n`,
  );
  return true;
}

// ---------------------------------------------------------------------------------------------
// Survey

export interface SurveyEntry {
  readonly sha: string;
  readonly pr: number | null;
  readonly title: string;
  readonly status: "clean" | "resolved" | "needs-person";
  readonly reasons: ReadonlyArray<string>;
  /** Fork features whose ledger paths the upstream commit changes. */
  readonly features: ReadonlyArray<string>;
}

/** Ledger feature ids by the implementation and upstream paths each entry lists. */
export function ledgerFeaturesByPath(ledger: string): ReadonlyMap<string, ReadonlyArray<string>> {
  const byPath = new Map<string, Array<string>>();
  let id: string | undefined;
  let listing = false;
  for (const line of ledger.split("\n")) {
    const entry = /^ {2}- id: (\S+)/u.exec(line);
    if (entry) {
      id = entry[1];
      listing = false;
      continue;
    }
    if (/^ {4}(implementation_paths|upstream_paths):\s*$/u.test(line)) {
      listing = true;
      continue;
    }
    if (/^ {4}\S/u.test(line)) listing = false;
    const path = listing ? /^ {6}- (\S+)\s*$/u.exec(line)?.[1] : undefined;
    if (path && id) byPath.set(path, [...(byPath.get(path) ?? []), id]);
  }
  return byPath;
}

/**
 * Applies the next queue entries from `base` in a scratch worktree to find the ones that will need
 * a person, so their work can start before the batch reaches them. A pick that stops takes
 * upstream's side to keep going; rerere stays off so none of those guesses is recorded.
 */
function survey(
  cwd: string,
  options: { readonly base: string; readonly count: number; readonly through?: string },
): ReadonlyArray<SurveyEntry> {
  const directory = NodePath.join(
    git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(),
    "intake-survey",
  );
  run(cwd, "git", ["worktree", "remove", "--force", directory]);
  NodeFS.rmSync(directory, { recursive: true, force: true });
  git(cwd, ["worktree", "add", "-q", "--detach", directory, options.base]);
  const featuresByPath = ledgerFeaturesByPath(readIfExists(NodePath.join(cwd, LEDGER)));
  const results: Array<SurveyEntry> = [];
  try {
    const entries = queueEntries(cwd, {
      count: options.count,
      forkRef: options.base,
      ...(options.through === undefined ? {} : { through: options.through }),
    });
    for (const entry of entries) {
      const changedPaths = lines(
        git(cwd, [
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          "-m",
          "--first-parent",
          entry.sha,
        ]),
      );
      const features = [
        ...new Set(changedPaths.flatMap((path) => featuresByPath.get(path) ?? [])),
      ].toSorted();
      let reasons: ReadonlyArray<string>;
      let status: SurveyEntry["status"];
      try {
        const outcome = pickUpstreamCommit(directory, entry.sha, {
          rerere: false,
          skipLockfile: true,
        });
        const upstreamNames = outcome.status === "stopped" ? [] : addedUpstreamNames(directory);
        for (const file of outcome.unresolved) {
          const taken = run(directory, "git", ["checkout", "--theirs", "--", file.path]);
          git(
            directory,
            taken.status === 0 ? ["add", "--", file.path] : ["rm", "-q", "--", file.path],
          );
        }
        commitPick(directory, entry, outcome);
        const differsWithoutNote =
          outcome.status !== "stopped" &&
          commitMatchesUpstream(directory, "HEAD") === false &&
          forkAdaptationNote(git(directory, ["show", "-s", "--format=%B", "HEAD"])) === null;
        reasons = autoStopReasons({ outcome, upstreamNames, differsWithoutNote });
        status =
          reasons.length > 0 ? "needs-person" : outcome.status === "clean" ? "clean" : "resolved";
      } catch (error) {
        run(directory, "git", ["cherry-pick", "--quit"]);
        run(directory, "git", ["reset", "-q", "--hard", "HEAD"]);
        reasons = [
          `could not apply: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
        ];
        status = "needs-person";
      }
      results.push({ sha: entry.sha, pr: entry.pr, title: entry.title, status, reasons, features });
    }
  } finally {
    run(cwd, "git", ["worktree", "remove", "--force", directory]);
  }
  return results;
}

/** One line per commit that needs a person, with its reasons and the fork features it touches. */
export function summarizeSurvey(entries: ReadonlyArray<SurveyEntry>): string {
  const count = (status: SurveyEntry["status"]) =>
    entries.filter((entry) => entry.status === status).length;
  const parts = [
    `Surveyed ${entries.length} commits: ${count("clean")} clean, ${count("resolved")} resolved, ${count("needs-person")} need a person.`,
  ];
  for (const entry of entries.filter((candidate) => candidate.status === "needs-person")) {
    parts.push(
      `\n${entry.sha.slice(0, 10)} ${entry.pr === null ? "direct" : `#${entry.pr}`} ${entry.title}`,
    );
    for (const reason of entry.reasons) parts.push(`    ${reason}`);
    if (entry.features.length > 0) parts.push(`    fork features: ${entry.features.join(", ")}`);
  }
  return `${parts.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// Replay

export interface ReplayResult {
  readonly commit: string;
  readonly subject: string;
  readonly source: string | null;
  readonly verdict:
    | "clean-match"
    | "resolved-match"
    | "resolved-differs"
    | "resolved-reordered"
    | "clean-differs"
    | "stopped"
    | "skipped";
  readonly adaptations: ReadonlyArray<AdaptationKind>;
  readonly unresolvedHunks: number;
  readonly differingFiles: ReadonlyArray<string>;
  readonly realHadNote: boolean;
}

/** The commit before a batch: the first ancestor on the first-parent chain without intake trailers. */
function batchBase(head: string): string {
  let commit = head;
  for (;;) {
    const message = git(repoRoot, ["show", "-s", "--format=%B", commit]);
    if (cherryPickSources(message).length === 0 && !/^Upstream-(PR|Commit):/mu.test(message)) {
      return commit;
    }
    commit = git(repoRoot, ["rev-parse", `${commit}^`]).trim();
  }
}

/**
 * Re-runs the driver on each commit of a promoted batch from that commit's real parent, and
 * compares the driver's tree with the tree the batch committed.
 */
function replay(
  candidate: string,
  options: { base?: string; skipLockfile: boolean; dump?: string },
): ReadonlyArray<ReplayResult> {
  const head = git(repoRoot, ["rev-parse", candidate]).trim();
  const base = options.base ?? batchBase(head);
  const commits = lines(
    git(repoRoot, ["rev-list", "--reverse", "--first-parent", `${base}..${head}`]),
  );
  const worktree = NodePath.join(repoRoot, ".scratch", `intake-replay-${head.slice(0, 10)}`);
  if (NodeFS.existsSync(worktree)) git(repoRoot, ["worktree", "remove", "--force", worktree]);
  git(repoRoot, ["worktree", "add", "-q", "--detach", worktree, base]);
  const results: Array<ReplayResult> = [];
  try {
    for (const commit of commits) {
      const message = git(repoRoot, ["show", "-s", "--format=%B", commit]);
      const subject = message.split("\n")[0] ?? commit;
      const sources = cherryPickSources(message);
      const realHadNote = forkAdaptationNote(message) !== null;
      if (sources.length !== 1) {
        results.push({
          commit,
          subject,
          source: null,
          verdict: "skipped",
          adaptations: [],
          unresolvedHunks: 0,
          differingFiles: [],
          realHadNote,
        });
        continue;
      }
      const source = sources[0]!;
      git(worktree, ["reset", "-q", "--hard"]);
      run(worktree, "git", ["cherry-pick", "--quit"]);
      git(worktree, ["checkout", "-q", "--detach", `${commit}^`]);
      git(worktree, ["clean", "-qfd"]);
      let outcome: PickOutcome;
      if (options.dump) hunkSink = [];
      try {
        // A recorded resolution of this very conflict would answer the question being scored.
        outcome = pickUpstreamCommit(worktree, source, {
          skipLockfile: options.skipLockfile,
          rerere: false,
        });
      } catch (error) {
        process.stderr.write(`${commit.slice(0, 10)}: ${String(error).slice(0, 300)}\n`);
        results.push({
          commit,
          subject,
          source,
          verdict: "skipped",
          adaptations: [],
          unresolvedHunks: 0,
          differingFiles: [],
          realHadNote,
        });
        continue;
      }
      const adaptations = [...new Set(outcome.adaptations.map((adaptation) => adaptation.kind))];
      if (options.dump && hunkSink && hunkSink.length > 0) {
        NodeFS.mkdirSync(options.dump, { recursive: true });
        const real = Object.fromEntries(
          [...new Set(hunkSink.map((entry) => entry.path))].map((path) => [
            path,
            run(repoRoot, "git", ["show", `${commit}:${path}`]).stdout,
          ]),
        );
        NodeFS.writeFileSync(
          NodePath.join(options.dump, `${commit.slice(0, 10)}.json`),
          JSON.stringify({ commit, subject, source, hunks: hunkSink, real }, null, 1),
        );
      }
      hunkSink = null;
      if (outcome.status === "stopped") {
        results.push({
          commit,
          subject,
          source,
          verdict: "stopped",
          adaptations,
          unresolvedHunks: outcome.unresolved.reduce((sum, file) => sum + file.hunks, 0),
          differingFiles: outcome.unresolved.map((file) => file.path),
          realHadNote,
        });
        continue;
      }
      git(worktree, ["add", "-A"]);
      const differingFiles = lines(
        git(worktree, ["diff", "--cached", "--name-only", "--no-renames", commit]),
      ).filter((path) => !(options.skipLockfile && path === LOCKFILE));
      const matched = differingFiles.length === 0;
      // The same lines in another order, as when two added imports land in either order.
      const reordered =
        !matched &&
        differingFiles.every((path) => {
          const sorted = (ref: string) =>
            run(worktree, "git", ["show", `${ref}:${path}`])
              .stdout.split("\n")
              .toSorted()
              .join("\n");
          return sorted(":0") === sorted(commit);
        });
      results.push({
        commit,
        subject,
        source,
        verdict:
          outcome.status === "clean"
            ? matched
              ? "clean-match"
              : "clean-differs"
            : matched
              ? "resolved-match"
              : reordered
                ? "resolved-reordered"
                : "resolved-differs",
        adaptations,
        unresolvedHunks: 0,
        differingFiles,
        realHadNote,
      });
    }
  } finally {
    run(worktree, "git", ["cherry-pick", "--quit"]);
    git(repoRoot, ["worktree", "remove", "--force", worktree]);
  }
  return results;
}

/**
 * Re-resolves hunks that `replay --dump` saved with the current resolvers and checks each
 * resolution against the file the batch committed. A resolution counts as correct when every
 * line it produces is in that file, so order and later edits nearby do not count against it.
 */
export function scoreDumpedHunks(
  directory: string,
  options: { exclude?: ReadonlyArray<string> } = {},
) {
  const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
  const counts = new Map<string, { correct: number; wrong: number }>();
  const wrong: Array<string> = [];
  let stopped = 0;
  for (const name of NodeFS.readdirSync(directory).filter((file) => file.endsWith(".json"))) {
    const dump = JSON.parse(NodeFS.readFileSync(NodePath.join(directory, name), "utf8")) as {
      commit: string;
      hunks: Array<{ path: string; hunk: { ours: string; base: string; theirs: string } }>;
      real: Record<string, string>;
    };
    if (options.exclude?.some((prefix) => dump.commit.startsWith(prefix))) continue;
    for (const { path, hunk } of dump.hunks) {
      if (path === LOCKFILE) continue;
      const resolution = resolveHunk(hunk, path);
      if (resolution.kind === "unresolved") {
        stopped += 1;
        continue;
      }
      const real = normalize(dump.real[path] ?? "");
      const ok = resolution.text
        .split("\n")
        .map(normalize)
        .filter((line) => line !== "")
        .every((line) => real.includes(line));
      const entry = counts.get(resolution.kind) ?? { correct: 0, wrong: 0 };
      if (ok) entry.correct += 1;
      else {
        entry.wrong += 1;
        wrong.push(`${resolution.kind} ${dump.commit.slice(0, 10)} ${path}`);
      }
      counts.set(resolution.kind, entry);
    }
  }
  return { stopped, counts: Object.fromEntries(counts), wrong };
}

function summarizeReplay(results: ReadonlyArray<ReplayResult>): string {
  const counts = new Map<string, number>();
  for (const result of results) counts.set(result.verdict, (counts.get(result.verdict) ?? 0) + 1);
  const rows = results.map((result) => {
    const detail = [
      result.adaptations.length > 0 ? `adapted: ${result.adaptations.join(", ")}` : "",
      result.unresolvedHunks > 0 ? `${result.unresolvedHunks} unresolved hunks` : "",
      result.differingFiles.length > 0
        ? `files: ${result.differingFiles.slice(0, 6).join(", ")}${result.differingFiles.length > 6 ? ", …" : ""}`
        : "",
      result.realHadNote ? "(real commit has a note)" : "",
    ]
      .filter((part) => part !== "")
      .join("; ");
    return `${result.verdict.padEnd(16)} ${result.commit.slice(0, 10)} ${result.subject.slice(0, 80)}${detail ? `\n${" ".repeat(28)}${detail}` : ""}`;
  });
  return `${rows.join("\n")}\n\n${[...counts].map(([verdict, count]) => `${verdict}: ${count}`).join(", ")}\n`;
}

// ---------------------------------------------------------------------------------------------
// Verify

/** Workspace packages that own the given paths, by their nearest package.json directory. */
function owningPackages(cwd: string, paths: ReadonlyArray<string>): ReadonlyArray<string> {
  const packages = new Set<string>();
  for (const path of paths) {
    let directory = NodePath.dirname(path);
    while (directory !== "." && !NodeFS.existsSync(NodePath.join(cwd, directory, "package.json"))) {
      directory = NodePath.dirname(directory);
    }
    if (directory !== ".") packages.add(directory);
  }
  return [...packages].toSorted();
}

/**
 * The environment checks run in: a styal session passes its own server settings and the service
 * launcher's context to the agents it runs, and server tests read them as if they were their own.
 * CI has none of them.
 */
export function verificationEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => !/^(T3CODE_|STYAL_)/u.test(name) && name !== "T3_SERVICE_LAUNCHER_CONTEXT",
    ),
  );
}

/** A workspace package as test selection sees it: where it lives and what its subpaths export. */
export interface WorkspacePackage {
  readonly directory: string;
  readonly exports: Readonly<Record<string, unknown>>;
}

const IMPORT_SPECIFIER = /(?:\bfrom|\bimport|\bvi\.(?:doMock|mock))\s*\(?\s*["']([^"']+)["']/gu;

/** Repository paths an import specifier in `testPath` may name; none for a third-party module. */
function importedPathCandidates(
  specifier: string,
  testPath: string,
  packageDirectory: string,
  workspace: ReadonlyMap<string, WorkspacePackage>,
): ReadonlyArray<string> {
  let target: string;
  if (specifier.startsWith(".")) {
    target = NodePath.posix.join(NodePath.posix.dirname(testPath), specifier);
  } else if (specifier.startsWith("~/")) {
    target = NodePath.posix.join(packageDirectory, "src", specifier.slice(2));
  } else {
    const name = [...workspace.keys()].find(
      (candidate) => specifier === candidate || specifier.startsWith(`${candidate}/`),
    );
    const owner = name === undefined ? undefined : workspace.get(name);
    if (name === undefined || owner === undefined) return [];
    const entry = owner.exports[`.${specifier.slice(name.length)}`];
    const conditions: Record<string, unknown> =
      typeof entry === "object" && entry !== null ? { ...entry } : {};
    const file = [entry, conditions.import, conditions.default, conditions.types].find(
      (value): value is string => typeof value === "string",
    );
    if (file === undefined) return [];
    target = NodePath.posix.join(owner.directory, file);
  }
  const stem = target.replace(/\.(?:m?js|jsx)$/u, "");
  return [target, `${stem}.ts`, `${stem}.tsx`, `${target}/index.ts`, `${target}/index.tsx`];
}

/**
 * Test files the batch changes, plus test files that import a changed file directly: by relative
 * path, the web `~/` alias, or a workspace package export. Imports through other modules are left
 * to Fork CI's whole suites; following them selects most of a package's suite.
 */
export function relatedTestFiles(input: {
  readonly changed: ReadonlyArray<string>;
  readonly testFiles: ReadonlyArray<string>;
  readonly packageOf: (path: string) => string | undefined;
  readonly workspace: ReadonlyMap<string, WorkspacePackage>;
  readonly readFile: (path: string) => string;
}): ReadonlyArray<string> {
  const changed = new Set(input.changed);
  return input.testFiles.filter((testPath) => {
    if (changed.has(testPath)) return true;
    const packageDirectory = input.packageOf(testPath);
    if (packageDirectory === undefined) return false;
    return [...input.readFile(testPath).matchAll(IMPORT_SPECIFIER)].some(
      ([, specifier]) =>
        specifier !== undefined &&
        importedPathCandidates(specifier, testPath, packageDirectory, input.workspace).some(
          (path) => changed.has(path),
        ),
    );
  });
}

export interface PlannedTestRun {
  readonly name: string;
  readonly directory: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * The test commands verify runs. `all` runs the `test` script of every package the batch touches,
 * as Fork CI does. `related` runs only the given test files through the owning package's
 * `vp test run` script, so its config and flags still apply; a package whose test script is
 * anything else runs that script whole.
 */
export function plannedTestRuns(input: {
  readonly mode: "related" | "all";
  readonly touchedPackages: ReadonlyArray<string>;
  readonly testScripts: ReadonlyMap<string, string>;
  readonly relatedTests: ReadonlyArray<string>;
}): ReadonlyArray<PlannedTestRun> {
  if (input.mode === "all") {
    return input.touchedPackages
      .filter((directory) => input.testScripts.has(directory))
      .map((directory) => ({
        name: `tests ${directory}`,
        directory,
        command: "pnpm",
        args: ["run", "test"],
      }));
  }
  const byPackage = new Map<string, Array<string>>();
  for (const path of input.relatedTests) {
    const directory = [...input.testScripts.keys()]
      .filter((candidate) => path.startsWith(`${candidate}/`))
      .toSorted((left, right) => right.length - left.length)[0];
    if (directory === undefined) continue;
    byPackage.set(directory, [...(byPackage.get(directory) ?? []), path]);
  }
  return [...byPackage]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([directory, paths]) => {
      const tests = paths.map((path) => path.slice(directory.length + 1));
      const script = (input.testScripts.get(directory) ?? "").trim().split(/\s+/u);
      const name = `tests ${directory} (${tests.length} related file${tests.length === 1 ? "" : "s"})`;
      return script.slice(0, 3).join(" ") === "vp test run"
        ? { name, directory, command: "vp", args: [...script.slice(1), ...tests] }
        : { name, directory, command: "pnpm", args: ["run", "test"] };
    });
}

/** The test commands for a batch's changed files, reading the workspace from `cwd`. */
function verifyTestRuns(
  cwd: string,
  changed: ReadonlyArray<string>,
  mode: "related" | "all",
): ReadonlyArray<PlannedTestRun> {
  const workspace = new Map<string, WorkspacePackage>();
  const testScripts = new Map<string, string>();
  for (const manifest of lines(git(cwd, ["ls-files", "--", "*/package.json"]))) {
    if (manifest.startsWith(".repos/")) continue;
    const directory = NodePath.posix.dirname(manifest);
    const json = JSON.parse(readIfExists(NodePath.join(cwd, manifest)) || "{}") as {
      readonly name?: unknown;
      readonly exports?: unknown;
      readonly scripts?: { readonly test?: unknown };
    };
    if (typeof json.name === "string") {
      const exports: Record<string, unknown> =
        typeof json.exports === "object" && json.exports !== null ? { ...json.exports } : {};
      workspace.set(json.name, { directory, exports });
    }
    if (typeof json.scripts?.test === "string") testScripts.set(directory, json.scripts.test);
  }
  return plannedTestRuns({
    mode,
    touchedPackages: owningPackages(cwd, changed),
    testScripts,
    relatedTests:
      mode === "all"
        ? []
        : relatedTestFiles({
            changed,
            testFiles: lines(git(cwd, ["ls-files", "--", "*.test.ts", "*.test.tsx"])).filter(
              (path) => !path.startsWith(".repos/"),
            ),
            packageOf: (path) => owningPackages(cwd, [path])[0],
            workspace,
            readFile: (path) => readIfExists(NodePath.join(cwd, path)),
          }),
  });
}

/**
 * Installs once, then typechecks every package the batch touches, lints its changed files, runs
 * the tests related to the batch (the whole suite of every touched package with `allTests`),
 * checks formatting, and checks the ledger. Prints one line per step and the failures in full.
 * Whole suites run in Fork CI, which every candidate must pass before promotion.
 */
function verify(cwd: string, base: string, options: { readonly allTests?: boolean } = {}): boolean {
  const changed = lines(git(cwd, ["diff", "--name-only", "--no-renames", `${base}...HEAD`])).filter(
    (path) => !path.startsWith(".repos/") && NodeFS.existsSync(NodePath.join(cwd, path)),
  );
  const packages = owningPackages(cwd, changed).filter((directory) =>
    /"typecheck"\s*:/u.test(readIfExists(NodePath.join(cwd, directory, "package.json"))),
  );
  const steps: Array<{ name: string; ok: boolean; output: string }> = [];
  const env = verificationEnvironment(process.env);
  const step = (name: string, command: string, args: ReadonlyArray<string>, directory = cwd) => {
    const result = run(directory, command, args, undefined, env);
    steps.push({ name, ok: result.status === 0, output: `${result.stdout}\n${result.stderr}` });
    process.stdout.write(`${result.status === 0 ? "ok  " : "FAIL"} ${name}\n`);
  };
  step("install", "vp", ["i"]);
  for (const directory of packages) {
    step(`typecheck ${directory}`, "pnpm", ["run", "typecheck"], NodePath.join(cwd, directory));
  }
  const sources = changed.filter((path) => /\.(ts|tsx|mts|mjs|js)$/u.test(path));
  if (sources.length > 0)
    step("lint changed files", "vp", ["lint", "--report-unused-disable-directives", ...sources]);
  const testRuns = verifyTestRuns(cwd, changed, options.allTests ? "all" : "related");
  if (testRuns.length === 0) process.stdout.write("--   no tests related to the batch\n");
  for (const test of testRuns) {
    step(test.name, test.command, test.args, NodePath.join(cwd, test.directory));
  }
  // Renames and moved imports can leave lines the formatter would wrap differently.
  step("formatting", "vp", ["fmt", "--check", "--no-error-on-unmatched-pattern", ...changed]);
  step("ledger", "vp", ["run", "--filter", "@t3tools/scripts", "ledger:check"]);
  for (const failed of steps.filter((entry) => !entry.ok)) {
    const relevant = failed.output
      .split("\n")
      .filter((line) => /error|fail|×|✗/iu.test(line))
      .slice(0, 40)
      .join("\n");
    process.stdout.write(`\n--- ${failed.name}\n${relevant || failed.output.slice(-4000)}\n`);
  }
  return steps.every((entry) => entry.ok);
}

// ---------------------------------------------------------------------------------------------
// Native fingerprint

/**
 * What `.github/workflows/mobile-fingerprint-check.yml` treats as fingerprint inputs. Intake
 * batches land without a pull request, so that check never runs on them.
 */
const NATIVE_FINGERPRINT_INPUTS = [
  "apps/mobile/",
  "packages/client-runtime/",
  "packages/contracts/",
  "packages/shared/",
  "assets/",
  "scripts/",
  "patches/",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".easignore",
];

const NATIVE_PLATFORMS = ["ios", "android"] as const;

export type NativeFingerprintComparison =
  | "inputs unchanged"
  | { readonly error: string }
  | ReadonlyArray<{
      readonly platform: (typeof NATIVE_PLATFORMS)[number];
      readonly base: string;
      readonly head: string;
    }>;

export function touchesNativeFingerprint(paths: ReadonlyArray<string>): boolean {
  return paths.some((path) =>
    NATIVE_FINGERPRINT_INPUTS.some((input) =>
      input.endsWith("/") ? path.startsWith(input) : path === input,
    ),
  );
}

function nativeFingerprints(root: string, env: NodeJS.ProcessEnv) {
  return NATIVE_PLATFORMS.map((platform) => {
    const result = run(
      NodePath.join(root, "apps/mobile"),
      "npx",
      ["expo-updates", "fingerprint:generate", "--platform", platform],
      undefined,
      { ...env, APP_VARIANT: "production", NODE_OPTIONS: "--max-old-space-size=8192" },
    );
    const hash =
      result.status === 0 ? (JSON.parse(result.stdout) as { hash?: unknown }).hash : null;
    if (typeof hash !== "string") {
      throw new Error(`${platform} fingerprint failed: ${result.stderr.trim().slice(-2000)}`);
    }
    return { platform, hash };
  });
}

/**
 * Fingerprints `HEAD` in place and `base` in a scratch worktree installed from its own lockfile,
 * as the pull request check does, so a dependency change is not measured against the batch's
 * installed packages.
 */
function compareNativeFingerprints(
  cwd: string,
  base: string,
  env: NodeJS.ProcessEnv,
): NativeFingerprintComparison {
  const directory = NodePath.join(
    git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(),
    "intake-fingerprint",
  );
  try {
    const head = nativeFingerprints(cwd, env);
    run(cwd, "git", ["worktree", "remove", "--force", directory]);
    NodeFS.rmSync(directory, { recursive: true, force: true });
    git(cwd, ["worktree", "add", "-q", "--detach", directory, base]);
    const install = run(
      directory,
      "pnpm",
      ["install", "--frozen-lockfile", "--filter=@t3tools/mobile..."],
      undefined,
      env,
    );
    if (install.status !== 0) throw new Error(`base install failed: ${install.stderr.trim()}`);
    const baseHashes = nativeFingerprints(directory, env);
    return head.map(({ platform, hash }) => ({
      platform,
      head: hash,
      base: baseHashes.find((entry) => entry.platform === platform)!.hash,
    }));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    run(cwd, "git", ["worktree", "remove", "--force", directory]);
  }
}

function nativeFingerprintComparison(
  cwd: string,
  base: string,
  changed: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): NativeFingerprintComparison {
  return touchesNativeFingerprint(changed)
    ? compareNativeFingerprints(cwd, base, env)
    : "inputs unchanged";
}

/** `unknown` when the comparison failed; promotion treats it like `moved`. */
export function nativeFingerprintVerdict(
  comparison: NativeFingerprintComparison,
): "unchanged" | "moved" | "unknown" {
  if (comparison === "inputs unchanged") return "unchanged";
  if ("error" in comparison) return "unknown";
  return comparison.some((entry) => entry.base !== entry.head) ? "moved" : "unchanged";
}

const PLATFORM_NAMES = { ios: "iOS", android: "Android" } as const;

export function describeNativeFingerprint(comparison: NativeFingerprintComparison): string {
  if (comparison === "inputs unchanged") {
    return "Native fingerprint: the batch changes none of its inputs, so OTA updates reach the same builds as before.";
  }
  if ("error" in comparison) {
    return `Native fingerprint: not compared (${comparison.error}). Compare it by hand before relying on an OTA update.`;
  }
  const moved = comparison.filter((entry) => entry.base !== entry.head);
  if (moved.length === 0) {
    return "Native fingerprint: unchanged on iOS and Android, so OTA updates reach the same builds as before.";
  }
  const platforms = moved.map((entry) => PLATFORM_NAMES[entry.platform]).join(" and ");
  return `Native fingerprint: moved on ${platforms} (${moved.map((entry) => `${entry.base.slice(0, 10)} → ${entry.head.slice(0, 10)}`).join(", ")}). After promotion, OTA updates no longer reach installed ${platforms} apps; they need a production build (Mobile EAS Production, mode=build).`;
}

// ---------------------------------------------------------------------------------------------
// References

interface Provided<T> {
  readonly value: T;
  /** The upstream commit whose change this follows. */
  readonly source: string;
}

/** Renames and file moves the batch's upstream commits make, each tagged with its commit. */
function batchRenames(cwd: string, sources: ReadonlyArray<string>) {
  const byFile = new Map<string, Map<string, Provided<string>>>();
  const exported = new Map<string, Provided<string>>();
  const moves = new Map<string, Provided<string>>();
  for (const source of sources) {
    const patch = git(cwd, [
      "diff",
      "-U0",
      "--no-renames",
      `${source}^`,
      source,
      "--",
      ".",
      ":!.repos",
    ]);
    for (const chunk of patch.split(/^(?=diff --git )/mu)) {
      const header = /^diff --git a\/(\S+) b\/(\S+)/u.exec(chunk);
      if (!header) continue;
      const renames = new Map(deriveIdentifierRenames(chunk));
      // A renamed export whose declaration was also reformatted does not pair line by line;
      // the file's removed and added exported names pair in order when their counts match.
      const declared = (sign: string) =>
        chunk
          .split("\n")
          .flatMap((line) =>
            line.startsWith(sign)
              ? (/^.\s*export\s+(?:const|function|class|let)\s+([A-Za-z_$][\w$]*)/u.exec(
                  line,
                )?.[1] ?? [])
              : [],
          );
      const removedExports = declared("-");
      const addedExports = declared("+");
      if (removedExports.length === addedExports.length) {
        removedExports.forEach((from, index) => {
          const to = addedExports[index]!;
          if (from !== to && !renames.has(from)) renames.set(from, to);
        });
      }
      if (renames.size === 0) continue;
      const file = byFile.get(header[2]!) ?? new Map<string, Provided<string>>();
      const exports = new Set(
        chunk
          .split("\n")
          .filter((line) => /^-\s*export\b/u.test(line))
          .flatMap((line) => line.match(/[A-Za-z_$][\w$]*/gu) ?? []),
      );
      for (const [from, to] of renames) {
        file.set(from, { value: to, source });
        if (exports.has(from)) exported.set(from, { value: to, source });
      }
      byFile.set(header[2]!, file);
    }
    const fields = git(cwd, ["diff", "-M", "--name-status", "-z", `${source}^`, source]).split(
      "\0",
    );
    const deleted: Array<string> = [];
    const arrived: Array<string> = [];
    for (let index = 0; index < fields.length; index += 1) {
      const status = fields[index]!;
      if (status.startsWith("R")) {
        moves.set(fields[index + 1]!, { value: fields[index + 2]!, source });
        arrived.push(fields[index + 2]!);
        index += 2;
      } else if (status !== "") {
        if (status === "D") deleted.push(fields[index + 1]!);
        if (status === "A") arrived.push(fields[index + 1]!);
        index += 1;
      }
    }
    for (const [from, to] of mergedModuleMoves(deleted, arrived)) {
      moves.set(from, { value: to, source });
    }
  }
  return { byFile, exported, moves };
}

const MODULE_EXTENSIONS = ["", ".ts", ".tsx", "/index.ts"];

/**
 * Typechecks the packages the batch touches and fixes fork references to what its upstream
 * commits renamed or moved, until a round fixes nothing. Each fix is committed into the pick
 * whose upstream commit made the rename or move. Returns the errors it could not fix.
 */
function fixReferences(cwd: string, base: string): ReadonlyArray<string> {
  requireCleanIndex(cwd);
  const commits = lines(git(cwd, ["rev-list", "--reverse", `${base}..HEAD`]));
  const pickBySource = new Map<string, string>();
  for (const commit of commits) {
    const source = cherryPickSources(git(cwd, ["show", "-s", "--format=%B", commit]))[0];
    if (source) pickBySource.set(source, commit);
  }
  const { byFile, exported, moves } = batchRenames(cwd, [...pickBySource.keys()]);
  const movedFrom = new Map([...moves].map(([from, to]) => [to.value, from]));
  const changed = lines(git(cwd, ["diff", "--name-only", "--no-renames", `${base}...HEAD`]));
  const packages = owningPackages(cwd, changed).filter((directory) =>
    /"typecheck"\s*:/u.test(readIfExists(NodePath.join(cwd, directory, "package.json"))),
  );
  const fileSource = new Map<string, string>();
  let remaining: Array<string> = [];
  for (let round = 0; round < 6; round += 1) {
    remaining = [];
    let fixed = 0;
    for (const directory of packages) {
      const result = run(NodePath.join(cwd, directory), "pnpm", ["run", "typecheck"]);
      for (const error of parseReferenceErrors(`${result.stdout}\n${result.stderr}`, directory)) {
        const absolute = NodePath.join(cwd, error.file);
        if (!NodeFS.existsSync(absolute)) continue;
        const text = NodeFS.readFileSync(absolute, "utf8");
        let next = text;
        let source: string | undefined;
        if (error.kind === "module") {
          const oldFile = movedFrom.get(error.file) ?? error.file;
          const target = NodePath.posix.normalize(
            NodePath.posix.join(NodePath.posix.dirname(oldFile), error.module),
          );
          const move = MODULE_EXTENSIONS.map((extension) => moves.get(target + extension)).find(
            (candidate) => candidate !== undefined,
          );
          const destination = move?.value ?? target;
          if (
            MODULE_EXTENSIONS.some((extension) =>
              NodeFS.existsSync(NodePath.join(cwd, destination + extension)),
            )
          ) {
            const specifier = relativeSpecifier(error.file, destination);
            next = text.split(`"${error.module}"`).join(`"${specifier}"`);
            source = move?.source;
          }
        } else {
          const rename = byFile.get(error.file)?.get(error.name) ?? exported.get(error.name);
          // A bare `layer` needs its module's namespace, and a name the file declares more than
          // once is shadowed somewhere, so the rename could bind the wrong one. Both stay for a
          // person.
          const declarations =
            rename === undefined
              ? 0
              : (
                  text.match(
                    new RegExp(
                      `\\b(const|let|var|function|class)\\s+${rename.value.replace(/\$/gu, "\\$")}\\b`,
                      "gu",
                    ),
                  ) ?? []
                ).length;
          const usable =
            rename !== undefined &&
            declarations <= 1 &&
            (rename.value !== "layer" || error.kind === "export");
          if (rename !== undefined && usable) {
            source = rename.source;
            next =
              error.kind === "export" && rename.value === "layer"
                ? useNamespaceImport(text, {
                    specifier: error.module,
                    name: error.name,
                    alias: namespaceAlias(error.module),
                    member: rename.value,
                  })
                : renameIdentifier(text, error.name, rename.value);
          }
        }
        if (next !== text) {
          NodeFS.writeFileSync(absolute, next);
          fixed += 1;
          if (source !== undefined) fileSource.set(error.file, source);
        } else {
          remaining.push(`${error.file}: ${error.kind === "module" ? error.module : error.name}`);
        }
      }
    }
    if (fixed === 0) break;
  }
  // Commit each file's fixes into the pick whose upstream change made them necessary.
  const groups = new Map<string, Array<string>>();
  for (const [file, source] of fileSource) {
    const pick = pickBySource.get(source);
    if (pick) groups.set(pick, [...(groups.get(pick) ?? []), file]);
  }
  for (const [pick, files] of groups) {
    git(cwd, ["add", "--", ...files]);
    git(cwd, ["commit", "-q", "--no-verify", `--fixup=${pick}`]);
  }
  if (groups.size > 0) {
    const sources = new Map(
      [...groups].map(([pick, files]) => [
        cherryPickSources(git(cwd, ["show", "-s", "--format=%B", pick]))[0]!,
        files,
      ]),
    );
    git(cwd, ["-c", "sequence.editor=true", "rebase", "-q", "-i", "--autosquash", base]);
    noteReferenceFixes(cwd, base, sources);
  }
  return [...new Set(remaining)];
}

/** Adds a sentence to each listed pick's fork note naming the files whose references it fixed. */
function noteReferenceFixes(
  cwd: string,
  base: string,
  filesBySource: ReadonlyMap<string, ReadonlyArray<string>>,
) {
  const branch = git(cwd, ["symbolic-ref", "--short", "HEAD"]).trim();
  const commits = lines(git(cwd, ["rev-list", "--reverse", `${base}..HEAD`]));
  git(cwd, ["checkout", "-q", "--detach", `${commits[0]!}^`]);
  try {
    for (const commit of commits) {
      git(cwd, ["cherry-pick", "--allow-empty", "--keep-redundant-commits", commit]);
      const message = git(cwd, ["show", "-s", "--format=%B", "HEAD"]);
      const files = filesBySource.get(cherryPickSources(message)[0] ?? "");
      if (!files) continue;
      const sentence = `Fork-only code takes upstream's renamed names and moved modules in ${files
        .toSorted()
        .map((file) => `\`${file}\``)
        .join(", ")}.`;
      const updated = /^Fork adaptation: /mu.test(message)
        ? message.replace(/^(Fork adaptation: .*?)(\n\n|\n?$)/msu, `$1 ${sentence}$2`)
        : message.replace(
            /\n\n(\(cherry picked from commit )/u,
            `\n\nFork adaptation: ${sentence}\n\n$1`,
          );
      git(cwd, ["commit", "-q", "--amend", "--no-verify", "-F", "-"], updated);
    }
  } catch (error) {
    run(cwd, "git", ["cherry-pick", "--abort"]);
    git(cwd, ["switch", "-q", "--discard-changes", branch]);
    throw error;
  }
  git(cwd, ["switch", "-q", "-C", branch]);
}

// ---------------------------------------------------------------------------------------------
// CLI

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main() {
  const [command, ...rest] = process.argv.slice(2).filter((argument) => argument !== "--");
  const cwd = repoRoot;
  switch (command) {
    case "apply": {
      const count = flag("--count");
      const through = flag("--through");
      const commits = flag("--commits");
      if (count === undefined && through === undefined && commits === undefined) {
        throw new Error("apply needs --count, --through, or --commits.");
      }
      const entries =
        commits === undefined
          ? queueEntries(cwd, {
              ...(count === undefined ? {} : { count: Number(count) }),
              ...(through === undefined ? {} : { through }),
            })
          : explicitEntries(cwd, commits.split(","));
      const branch = flag("--branch");
      if (branch) git(cwd, ["switch", "-q", "-c", branch, "--no-track", "origin/main"]);
      const done = applyEntries(cwd, entries, {
        skipLockfile: process.argv.includes("--skip-lockfile"),
        rerere: !process.argv.includes("--no-rerere"),
      });
      if (done)
        process.stdout.write(
          "\nAll commits applied. Run `intake-run.ts fix-trailers`, then `intake-run.ts verify`.\n",
        );
      process.exitCode = done ? 0 : 2;
      return;
    }
    case "continue": {
      const state = JSON.parse(NodeFS.readFileSync(statePath(cwd), "utf8")) as RunState;
      if (state.current === null) throw new Error("No stopped pick to continue.");
      // A lockfile left for this step: regenerate it now that the manifests are resolved.
      let lockfile = state.current.outcome.lockfile;
      if (unmergedFiles(cwd).some((file) => file.path === LOCKFILE)) {
        if (unmergedFiles(cwd).some((file) => MANIFEST.test(file.path))) {
          throw new Error("Resolve and stage the package manifests first.");
        }
        git(cwd, ["checkout", "--ours", "--", LOCKFILE]);
        lockfile = regenerateLockfile(cwd, state.current.entry.sha);
        git(cwd, ["add", "--", LOCKFILE]);
      }
      if (
        unmergedFiles(cwd).length > 0 ||
        /^\+(<{7}|\|{7}|>{7})( |$)/mu.test(git(cwd, ["diff", "--cached"]))
      ) {
        throw new Error("Conflicts remain; resolve and stage them first.");
      }
      const note = flag("--note");
      const features =
        flag("--feature")
          ?.split(",")
          .map((id) => id.trim())
          .filter((id) => id) ?? [];
      const changed = lines(git(cwd, ["diff", "--cached", "--name-only", "HEAD"]));
      const keys = rewriteServiceKeys(cwd, state.current.entry.sha, changed);
      const ledger = moveLedgerPathsForStagedRenames(cwd);
      const regenerated = lockfile !== state.current.outcome.lockfile;
      const outcome = {
        ...state.current.outcome,
        adaptations: [
          ...state.current.outcome.adaptations,
          ...keys,
          ...ledger,
          ...(regenerated ? [{ kind: "lockfile" as const, path: LOCKFILE }] : []),
        ],
        ...(lockfile ? { lockfile } : {}),
      };
      commitPick(cwd, state.current.entry, outcome, {
        ...(note ? { note } : {}),
        features,
      });
      const done = applyEntries(cwd, state.remaining, {
        skipLockfile: process.argv.includes("--skip-lockfile"),
        rerere: !process.argv.includes("--no-rerere"),
      });
      process.exitCode = done ? 0 : 2;
      return;
    }
    case "auto": {
      const branch = flag("--branch");
      if (!branch) throw new Error("auto needs --branch.");
      const max = Number(flag("--max") ?? DEFAULT_AUTO_MAX);
      if (!Number.isInteger(max) || max < 1) throw new Error("--max must be a positive integer.");
      process.exitCode = autoBatch(cwd, {
        branch,
        max,
        push: process.argv.includes("--push"),
        rerere: !process.argv.includes("--no-rerere"),
      })
        ? 0
        : 2;
      return;
    }
    case "push": {
      const branch = git(cwd, ["branch", "--show-current"]).trim();
      if (!branch.startsWith("intake/"))
        throw new Error("push needs an intake/ branch checked out.");
      process.exitCode = pushCandidate(cwd, branch) ? 0 : 2;
      return;
    }
    case "survey": {
      const count = Number(flag("--count") ?? 100);
      if (!Number.isInteger(count) || count < 1)
        throw new Error("--count must be a positive integer.");
      const through = flag("--through");
      const results = survey(cwd, {
        base: flag("--base") ?? "HEAD",
        count,
        ...(through === undefined ? {} : { through }),
      });
      process.stdout.write(
        process.argv.includes("--json")
          ? `${JSON.stringify(results, null, 2)}\n`
          : summarizeSurvey(results),
      );
      return;
    }
    case "fix-trailers": {
      const fixes = fixTrailers(cwd, flag("--base") ?? "origin/main");
      for (const fix of fixes)
        if (fix.action !== "ok") process.stdout.write(`${fix.action.padEnd(17)} ${fix.subject}\n`);
      process.exitCode = fixes.some((fix) => fix.action === "needs-note") ? 1 : 0;
      return;
    }
    case "replay": {
      const candidate = rest.find(
        (argument) =>
          !argument.startsWith("--") && argument !== flag("--base") && argument !== flag("--dump"),
      );
      if (!candidate) throw new Error("replay needs a promoted candidate SHA.");
      const base = flag("--base");
      const dump = flag("--dump");
      const results = replay(candidate, {
        ...(base ? { base } : {}),
        ...(dump ? { dump: NodePath.resolve(dump) } : {}),
        skipLockfile: process.argv.includes("--skip-lockfile"),
      });
      process.stdout.write(
        process.argv.includes("--json")
          ? `${JSON.stringify(results, null, 2)}\n`
          : summarizeReplay(results),
      );
      return;
    }
    case "verify": {
      process.exitCode = verify(cwd, flag("--base") ?? "origin/main", {
        allTests: process.argv.includes("--all-tests"),
      })
        ? 0
        : 1;
      return;
    }
    case "fingerprint": {
      const base = flag("--base") ?? "origin/main";
      const changed = lines(git(cwd, ["diff", "--name-only", "--no-renames", `${base}...HEAD`]));
      const comparison = nativeFingerprintComparison(
        cwd,
        base,
        changed,
        verificationEnvironment(process.env),
      );
      const report = describeNativeFingerprint(comparison);
      // Fork CI uploads this for the promotion workflow, which reads the verdict.
      process.stdout.write(
        process.argv.includes("--json")
          ? `${JSON.stringify({ sha: git(cwd, ["rev-parse", "HEAD"]).trim(), verdict: nativeFingerprintVerdict(comparison), report })}\n`
          : `${report}\n`,
      );
      return;
    }
    case "fix-references": {
      const unresolved = fixReferences(cwd, flag("--base") ?? "origin/main");
      if (unresolved.length > 0) {
        process.stdout.write(`Not fixed:\n${unresolved.join("\n")}\n`);
      }
      process.exitCode = unresolved.length > 0 ? 1 : 0;
      return;
    }
    case "score": {
      const directory = rest.find(
        (argument) => !argument.startsWith("--") && argument !== flag("--exclude"),
      );
      if (!directory) throw new Error("score needs the directory replay --dump wrote.");
      const exclude = flag("--exclude")?.split(",") ?? [];
      const result = scoreDumpedHunks(directory, { exclude });
      process.stdout.write(
        `${JSON.stringify({ stopped: result.stopped, ...result.counts }, null, 2)}\n`,
      );
      if (process.argv.includes("--verbose")) process.stdout.write(`${result.wrong.join("\n")}\n`);
      return;
    }
    default:
      process.stdout.write(
        "Usage: intake-run.ts apply (--count <n> | --through <sha> | --commits <sha,...>) [--branch <name>] | continue [--note <text>] [--feature <ids>] | auto --branch <name> [--max <n>] [--push] [--no-rerere] | push | survey [--base <ref>] [--count <n> | --through <sha>] [--json] | fix-trailers [--base <ref>] | verify [--base <ref>] [--all-tests] | fingerprint [--base <ref>] [--json] | replay <candidate-sha> [--base <sha>] [--skip-lockfile] [--json] [--dump <dir>] | score <dump-dir> [--exclude <sha-prefixes>] [--verbose]\n",
      );
      process.exitCode = command === undefined ? 0 : 1;
  }
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
