#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

/**
 * Applies upstream commits to an intake branch, resolving the conflicts that follow from known
 * fork differences and stopping on the rest. See docs/operations/upstream-tracking.md.
 *
 *   intake-run.ts apply (--count <n> | --through <upstream-sha> | --commits <sha,...>) [--branch <name>]
 *   intake-run.ts continue [--note <text>] [--feature <id,id>]
 *   intake-run.ts auto --branch <name> [--max <n>] [--push] [--hold-queued] [--no-rerere]
 *   intake-run.ts push [--hold-queued]
 *   intake-run.ts survey [--base HEAD] [--count 100 | --through <sha>] [--json]
 *   intake-run.ts review-brief [--base origin/main] [--out <file>]
 *   intake-run.ts fix-trailers [--base origin/main]
 *   intake-run.ts fix-references [--base origin/main]
 *   intake-run.ts verify [--base origin/main] [--all-tests | --quick]
 *   intake-run.ts replay <promoted-candidate-sha> [--base <fork-sha>] [--skip-lockfile] [--json] [--dump <dir>]
 *   intake-run.ts score <dump-dir> [--exclude <sha-prefixes>] [--verbose]
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { parse as parseYaml } from "yaml";

import {
  findUpstreamNames,
  isCheckedSource,
  namesUpstreamProductText,
  renameRepositoryUpstreamNames,
  upstreamNamesRenamed,
} from "../upstream-naming.ts";

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
import { type LaterCommit, type LaterFix, laterFixesByBatchCommit } from "./lib/later-fixes.ts";
import { parseUpstreamProvenance } from "./lib/provenance.ts";
import {
  namespaceAlias,
  parseReferenceErrors,
  relativeSpecifier,
  renameIdentifier,
  useNamespaceImport,
} from "./lib/references.ts";
import { applyIdentifierRenames, deriveIdentifierRenames } from "./lib/renames.ts";
import { decodeTrackedPRs } from "./lib/tracked-prs.ts";
import { HOLD_CONTEXT, holdForPushedCandidate } from "./landing-hold.ts";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);

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

/** `run` without blocking, so independent checks can share the machine. */
function runAsync(
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Promise<Run> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let overflowed = false;
    try {
      const child = NodeChildProcess.spawn(command, args, {
        cwd,
        env: { ...env, GIT_EDITOR: "true" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      // The same bound `run` gives spawnSync: a runaway step fails instead of exhausting memory.
      const capture = (chunk: string, append: (text: string) => void) => {
        if (overflowed) return;
        if (stdout.length + stderr.length + chunk.length > 256 * 1024 * 1024) {
          overflowed = true;
          child.kill();
          return;
        }
        append(chunk);
      };
      child.stdout
        .setEncoding("utf8")
        .on("data", (chunk: string) => capture(chunk, (text) => (stdout += text)));
      child.stderr
        .setEncoding("utf8")
        .on("data", (chunk: string) => capture(chunk, (text) => (stderr += text)));
      child.on("error", (error) =>
        resolve({ status: 1, stdout, stderr: `${stderr}${error.message}` }),
      );
      child.on("close", (status) =>
        resolve(
          overflowed
            ? { status: 1, stdout, stderr: `${stderr}\nOutput exceeded 256 MiB; stopped.` }
            : { status: status ?? 1, stdout, stderr },
        ),
      );
    } catch (error) {
      // An argument list over the system limit throws here rather than emitting `error`.
      resolve({
        status: 1,
        stdout,
        stderr: error instanceof Error ? error.message : String(error),
      });
    }
  });
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

export type AdaptationKind =
  | "rerere"
  | "identity"
  | "naming"
  | "upstream-rename"
  | "additions"
  | "fork-deletion"
  | "lockfile"
  | "service-keys"
  | "ledger-paths"
  | "patch-pins";

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
const WORKSPACE = "pnpm-workspace.yaml";
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

export interface OverridePin {
  readonly name: string;
  readonly version: string;
  readonly previous: string | null;
}

function workspaceSection(workspace: string, key: string): Record<string, unknown> {
  const parsed = (workspace.trim() === "" ? null : parseYaml(workspace)) as Record<
    string,
    unknown
  > | null;
  const section = parsed?.[key];
  return section !== null && typeof section === "object"
    ? (section as Record<string, unknown>)
    : {};
}

/**
 * Override pins for the packages an upstream commit starts patching. The fork pins every patched
 * package in `overrides` so lockfile-free release installs cannot drift past the patch; upstream
 * does not, so its new patches arrive unpinned. Catalog packages already pin through the catalog.
 */
export function patchOverridePins(input: {
  readonly upstreamBefore: string;
  readonly upstreamAfter: string;
  readonly fork: string;
}): ReadonlyArray<OverridePin> {
  const before = new Set(
    Object.keys(workspaceSection(input.upstreamBefore, "patchedDependencies")),
  );
  const overrides = workspaceSection(input.fork, "overrides");
  const catalog = workspaceSection(input.fork, "catalog");
  return Object.keys(workspaceSection(input.upstreamAfter, "patchedDependencies"))
    .filter((key) => !before.has(key))
    .flatMap((key): ReadonlyArray<OverridePin> => {
      const { name, version } = splitPackage(key);
      const current = overrides[name];
      if (current === undefined) return name in catalog ? [] : [{ name, version, previous: null }];
      if (typeof current !== "string" || current === version || current.startsWith("catalog:")) {
        return [];
      }
      return [{ name, version, previous: current }];
    });
}

/** Writes `pins` into the workspace's top-level `overrides` block, keeping its comments and order. */
export function applyOverridePins(workspace: string, pins: ReadonlyArray<OverridePin>): string {
  const lines = workspace.split("\n");
  const start = lines.indexOf("overrides:");
  if (start === -1) throw new Error("pnpm-workspace.yaml has no top-level overrides block.");
  let end = start + 1;
  while (end < lines.length && /^ {2}\S/u.test(lines[end]!)) end += 1;
  for (const pin of pins) {
    const key = pin.name.startsWith("@") ? JSON.stringify(pin.name) : pin.name;
    const line = `  ${key}: ${pin.version}`;
    const existing = lines.findIndex(
      (candidate, index) =>
        index > start &&
        index < end &&
        new RegExp(`^ {2}"?${escapeRegExp(pin.name)}"?:`, "u").test(candidate),
    );
    if (existing === -1) {
      lines.splice(end, 0, line);
      end += 1;
    } else {
      lines[existing] = line;
    }
  }
  return lines.join("\n");
}

/** Pins the packages `upstreamSha` starts patching, staging the workspace file it changes. */
function pinPatchedPackages(cwd: string, upstreamSha: string): ReadonlyArray<Adaptation> {
  const show = (ref: string) => run(cwd, "git", ["show", `${ref}:${WORKSPACE}`]).stdout;
  const path = NodePath.join(cwd, WORKSPACE);
  const fork = readIfExists(path);
  const pins = patchOverridePins({
    upstreamBefore: show(`${upstreamSha}^1`),
    upstreamAfter: show(upstreamSha),
    fork,
  });
  if (pins.length === 0) return [];
  NodeFS.writeFileSync(path, applyOverridePins(fork, pins));
  git(cwd, ["add", "--", WORKSPACE]);
  return [
    {
      kind: "patch-pins",
      path: WORKSPACE,
      detail: pins.map((pin) => `${pin.name}@${pin.version}`).join(", "),
    },
  ];
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

/**
 * Gives upstream's names in the strings the pick adds the fork's names, as `naming:check` requires,
 * along with the pick's test assertions that quote them.
 */
function renameStagedUpstreamNames(cwd: string): ReadonlyArray<Adaptation> {
  const renamed = renameRepositoryUpstreamNames(
    cwd,
    addedLineNumbers(git(cwd, ["diff", "--cached", "-U0", "HEAD"])),
  );
  if (renamed.size === 0) return [];
  git(cwd, ["add", "--", ...renamed.keys()]);
  return [...renamed].map(([path, renames]) => ({
    kind: "naming" as const,
    path,
    detail: upstreamNamesRenamed(renames).join(", "),
  }));
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
  const pins = manifestsPending ? [] : pinPatchedPackages(cwd, upstreamSha);
  adaptations.push(...pins);
  if (lockfileConflict && manifestsPending) {
    unresolved.push({ path: LOCKFILE, hunks: 1 });
  } else if (lockfileConflict || pins.length > 0) {
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
  if (unresolved.length === 0) {
    adaptations.push(...moveLedgerPathsForStagedRenames(cwd));
    adaptations.push(...renameStagedUpstreamNames(cwd));
  }
  return {
    upstreamSha,
    status: unresolved.length > 0 ? "stopped" : conflicts.length > 0 ? "resolved" : "clean",
    adaptations,
    unresolved,
    identityReview: unresolved.length > 0 ? [] : addedUpstreamNames(cwd),
    ...(lockfile ? { lockfile } : {}),
  };
}

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
  const naming = adaptations.filter((adaptation) => adaptation.kind === "naming");
  if (naming.length > 0) {
    const renames = [
      ...new Set(naming.flatMap((adaptation) => (adaptation.detail ?? "").split(", "))),
    ]
      .filter((rename) => rename !== "")
      .map((rename) => `\`${rename.replace(" -> ", "` to `")}\``);
    const files = [...new Set(naming.map((adaptation) => `\`${adaptation.path}\``))];
    sentences.push(
      `Upstream's new strings in ${files.join(", ")} use the fork's names (${renames.join(", ")}), as \`naming:check\` requires.`,
    );
    features.add(
      naming.some((adaptation) => AGENT_PATHS.test(adaptation.path))
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
  const pins = adaptations.filter((adaptation) => adaptation.kind === "patch-pins");
  if (pins.length > 0) {
    sentences.push(
      `\`${WORKSPACE}\` pins the newly patched ${pins.map((adaptation) => adaptation.detail).join(", ")} in \`overrides\`, as the fork pins every patched package so lockfile-free installs keep the patch.`,
    );
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

const DEFAULT_AUTO_MAX = 30;

/** Line numbers each file gains in the staged pick. */
export function addedLineNumbers(diff: string): ReadonlyMap<string, ReadonlySet<number>> {
  const added = new Map<string, Set<number>>();
  let path = "";
  let next = 0;
  for (const line of diff.split("\n")) {
    const header = /^\+\+\+ b\/(.+)$/u.exec(line);
    if (header) {
      path = header[1]!;
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)/u.exec(line);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+") && path !== "") {
      const lines = added.get(path) ?? new Set<number>();
      lines.add(next);
      added.set(path, lines);
      next += 1;
    }
  }
  return added;
}

/**
 * Upstream names the staged pick adds where the fork renames them and the driver could not, such
 * as t3.codes links: strings `naming:check` holds to the fork's naming, and the user guides.
 */
function addedUpstreamNames(cwd: string): ReadonlyArray<string> {
  const findings: Array<string> = [];
  for (const [path, lines] of addedLineNumbers(git(cwd, ["diff", "--cached", "-U0", "HEAD"]))) {
    if (isCheckedSource(path)) {
      for (const finding of findUpstreamNames(path, git(cwd, ["show", `:${path}`]))) {
        if (lines.has(finding.line)) findings.push(`${path}: ${finding.text.slice(0, 160)}`);
      }
    } else if (path.startsWith("docs/user/")) {
      const text = git(cwd, ["show", `:${path}`]).split("\n");
      for (const line of lines) {
        const added = text[line - 1] ?? "";
        if (namesUpstreamProductText(added))
          findings.push(`${path}: ${added.trim().slice(0, 160)}`);
      }
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

const forkRepository = () => process.env.GH_REPO ?? "incognitojam/styal";

/**
 * Applies the queue until a pick needs a person or `max` commits are in, then finishes the batch:
 * fixes references and trailers, verifies, and with `push` pushes it. A pick
 * that needs a person ends the batch before it; when it is the first, it stays staged for
 * `continue`, as `apply` leaves a stop.
 */
async function autoBatch(
  cwd: string,
  options: {
    readonly branch: string;
    readonly max: number;
    readonly push: boolean;
    readonly holdQueued: boolean;
    readonly rerere: boolean;
  },
): Promise<boolean> {
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
  if (!(await verify(cwd, "origin/main"))) return false;
  if (!options.push) {
    process.stdout.write(`\nVerified. Push it with intake-run.ts push.\n`);
    return true;
  }
  return pushCandidate(cwd, options.branch, { holdQueued: options.holdQueued });
}

export interface OpenPullRequest {
  readonly number: number;
  readonly title: string;
  readonly isDraft: boolean;
  readonly mergeable: string;
  readonly reviewDecision: string | null;
  readonly autoMergeRequest: unknown;
  readonly statusCheckRollup: ReadonlyArray<{
    readonly name?: string;
    readonly context?: string;
    readonly conclusion?: string | null;
    readonly state?: string | null;
  }>;
}

const FAILED_CHECK = new Set([
  "FAILURE",
  "ERROR",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

/**
 * Pull requests set to auto-merge that can still land on their own: not held by the landing hold,
 * not draft or conflicting, not waiting on a review, and with no failed check. Pushing a candidate
 * would hold them until it lands.
 */
export function queuedAutoMerges(
  pullRequests: ReadonlyArray<OpenPullRequest>,
): ReadonlyArray<OpenPullRequest> {
  return pullRequests.filter((pullRequest) => {
    if (pullRequest.autoMergeRequest === null || pullRequest.isDraft) return false;
    if (pullRequest.mergeable === "CONFLICTING") return false;
    if (
      pullRequest.reviewDecision === "REVIEW_REQUIRED" ||
      pullRequest.reviewDecision === "CHANGES_REQUESTED"
    ) {
      return false;
    }
    return pullRequest.statusCheckRollup.every((check) =>
      (check.context ?? check.name) === HOLD_CONTEXT
        ? check.state !== "PENDING"
        : !FAILED_CHECK.has(check.conclusion ?? check.state ?? ""),
    );
  });
}

function openPullRequests(cwd: string): ReadonlyArray<OpenPullRequest> | null {
  const result = run(cwd, "gh", [
    "pr",
    "list",
    "--repo",
    forkRepository(),
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,title,isDraft,mergeable,reviewDecision,autoMergeRequest,statusCheckRollup",
  ]);
  return result.status === 0 ? (JSON.parse(result.stdout) as Array<OpenPullRequest>) : null;
}

/**
 * Pushes an intake candidate and holds open pull requests while it lands. Promotion starts by
 * itself when Fork CI passes. Pull requests about to auto-merge go first unless `holdQueued`, and
 * the candidate rebases onto whatever they moved `main` to, so a person merging pull requests
 * never has to time it around the batch.
 */
async function pushCandidate(
  cwd: string,
  branch: string,
  options: { readonly holdQueued: boolean },
): Promise<boolean> {
  if (!options.holdQueued) {
    const pullRequests = openPullRequests(cwd);
    if (pullRequests === null) {
      process.stdout.write("Could not list open pull requests; not checking for auto-merges.\n");
    } else {
      const queued = queuedAutoMerges(pullRequests);
      if (queued.length > 0) {
        process.stdout.write(
          `\nThese pull requests are set to auto-merge and can still land; pushing now would hold them:\n${queued.map((pullRequest) => `  #${pullRequest.number} ${pullRequest.title}`).join("\n")}\n\nPush again once they land, or pass --hold-queued to hold them behind this batch.\n`,
        );
        return false;
      }
    }
  }
  git(cwd, [
    "fetch",
    "-q",
    "--prune",
    "origin",
    "main",
    "+refs/heads/intake/*:refs/remotes/origin/intake/*",
  ]);
  const isAncestor = (ancestor: string, descendant: string) =>
    run(cwd, "git", ["merge-base", "--is-ancestor", ancestor, descendant]).status === 0;
  // A batch pipelined on an earlier one waits for it: rebasing now would carry its commits along.
  const unlanded = lines(
    git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/intake/"]),
  ).filter(
    (ref) =>
      ref !== `origin/${branch}` && !isAncestor(ref, "origin/main") && isAncestor(ref, "HEAD"),
  );
  if (unlanded.length > 0) {
    process.stdout.write(
      `\nThis branch builds on ${unlanded.join(", ")}, which has not landed. Push it once that lands.\n`,
    );
    return false;
  }
  if (!isAncestor("origin/main", "HEAD")) {
    const rebase = run(cwd, "git", ["rebase", "-q", "origin/main"]);
    if (rebase.status !== 0) {
      run(cwd, "git", ["rebase", "--abort"]);
      throw new Error(
        `main moved and the batch does not rebase cleanly onto it. Rebase by hand, then push again.\n${rebase.stderr.trim()}`,
      );
    }
    process.stdout.write(
      `main moved; rebased onto ${git(cwd, ["rev-parse", "--short=10", "origin/main"]).trim()}.\n`,
    );
    if (!(await verify(cwd, "origin/main", { quick: true }))) {
      process.stdout.write(
        "\nThe rebased batch fails its quick checks; fix it, then push again.\n",
      );
      return false;
    }
  }
  git(cwd, ["push", "-q", "--force-with-lease", "-u", "origin", `HEAD:refs/heads/${branch}`]);
  const sha = git(cwd, ["rev-parse", "HEAD"]).trim();
  process.stdout.write(`\nPushed ${sha}.\n`);
  const forkCi = holdForPushedCandidate(forkRepository(), branch, sha);
  process.stdout.write(
    forkCi === null
      ? "Fork CI has not started for it; the Intake landing hold workflow holds pull requests once it does.\n"
      : `Fork CI: ${forkCi}\n`,
  );
  return true;
}

export interface SurveyEntry {
  readonly sha: string;
  readonly pr: number | null;
  readonly title: string;
  readonly status: "clean" | "resolved" | "needs-person";
  readonly reasons: ReadonlyArray<string>;
  /** Fork features whose ledger paths the upstream commit changes. */
  readonly features: ReadonlyArray<string>;
  /** Later upstream fixes, beyond the surveyed commits, that name this commit. */
  readonly laterFixes: ReadonlyArray<LaterFix>;
  /** Whether the commit changes lint rules or their configuration, which fork-only code must pass. */
  readonly changesLint?: boolean;
}

/** Lint rules and configuration, so a new or stricter rule is found before assembly. */
const LINT_CONFIG = /^oxlint-plugin-t3code\/(?!.*\.test\.ts$)|^vite\.config\.ts$/u;

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

/** First-parent upstream commits after `after`, each with its PR description. */
function laterUpstreamCommits(
  cwd: string,
  after: string,
  repository: string,
): ReadonlyArray<LaterCommit> {
  const commits = git(cwd, [
    "log",
    "--first-parent",
    "--format=%H%x00%B%x01",
    `${after}..upstream/main`,
  ])
    .split("\x01")
    .map((record) => record.replace(/^\n/u, ""))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = "", message = ""] = record.split("\0");
      const subject = message.split("\n", 1)[0]!.trim();
      const pr = /\(#(\d+)\)$|^Merge pull request #(\d+) /u.exec(subject);
      return { sha, pr: pr ? Number(pr[1] ?? pr[2]) : null, subject, message };
    });
  const [owner, name] = repository.split("/");
  const numbers = commits.flatMap((commit) => (commit.pr === null ? [] : [commit.pr]));
  const pullRequests = new Map<number, { readonly title: string; readonly body: string }>();
  for (let start = 0; start < numbers.length; start += 100) {
    const chunk = numbers.slice(start, start + 100);
    const query = `query { repository(owner:${JSON.stringify(owner)}, name:${JSON.stringify(name)}) { ${chunk.map((number) => `p${number}: pullRequest(number:${number}) { title body }`).join("\n")} } }`;
    const result = run(cwd, "gh", ["api", "graphql", "-f", `query=${query}`]);
    if (result.status !== 0)
      throw new Error(`Could not read upstream PR descriptions: ${result.stderr.trim()}`);
    const data = (
      JSON.parse(result.stdout) as {
        data?: { repository?: Record<string, { title: string; body: string } | null> };
      }
    ).data?.repository;
    if (!data) throw new Error("Could not read upstream PR descriptions.");
    for (const number of chunk) {
      const pullRequest = data[`p${number}`];
      if (pullRequest) pullRequests.set(number, pullRequest);
    }
  }
  return commits.map((commit) => {
    const pullRequest = commit.pr === null ? undefined : pullRequests.get(commit.pr);
    return {
      sha: commit.sha,
      pr: commit.pr,
      title: pullRequest?.title ?? commit.subject,
      text: pullRequest ? `${commit.message}\n${pullRequest.body}` : commit.message,
    };
  });
}

/**
 * Later upstream fixes to `batch` commits that `base` has not imported, with the fork's tracking
 * reason when it tracks one.
 */
function laterFixes(
  cwd: string,
  base: string,
  batch: ReadonlyArray<QueueEntry>,
): ReadonlyMap<string, ReadonlyArray<LaterFix>> {
  if (batch.length === 0) return new Map();
  const repository =
    (
      JSON.parse(readIfExists(NodePath.join(cwd, ".github/upstream-intake.json")) || "{}") as {
        upstreamRepository?: string;
      }
    ).upstreamRepository ?? "pingdotgg/t3code";
  const found = laterFixesByBatchCommit(
    batch,
    laterUpstreamCommits(cwd, batch.at(-1)!.sha, repository),
    repository,
  );
  const imported = parseUpstreamProvenance(
    git(cwd, ["log", "--format=%B%x01", "-E", "--grep=^Upstream-(PR|Commit):", base]).split("\x01"),
  );
  const importedPrs = new Set(imported.pullRequestNumbers);
  const importedShas = new Set(imported.commitShas);
  const trackedFile = run(cwd, "git", ["show", `${base}:.github/upstream-tracked-prs.json`]);
  const tracked = new Map(
    (trackedFile.status === 0 ? decodeTrackedPRs(trackedFile.stdout) : []).map((entry) => [
      entry.number,
      entry.reason,
    ]),
  );
  return new Map(
    [...found].map(([sha, fixes]) => [
      sha,
      fixes
        .filter(
          (fix) => !importedShas.has(fix.sha) && (fix.pr === null || !importedPrs.has(fix.pr)),
        )
        .map((fix) => {
          const reason = fix.pr === null ? undefined : tracked.get(fix.pr);
          return reason === undefined ? fix : { ...fix, tracked: reason };
        }),
    ]),
  );
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
    `intake-survey-${process.pid}`,
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
    const fixesByCommit = laterFixes(cwd, options.base, entries);
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
      results.push({
        sha: entry.sha,
        pr: entry.pr,
        title: entry.title,
        status,
        reasons,
        features,
        laterFixes: fixesByCommit.get(entry.sha) ?? [],
        ...(changedPaths.some((path) => LINT_CONFIG.test(path)) ? { changesLint: true } : {}),
      });
    }
  } finally {
    run(cwd, "git", ["worktree", "remove", "--force", directory]);
  }
  return results;
}

const describeCommit = (sha: string, pr: number | null, title: string) =>
  `${sha.slice(0, 10)} ${pr === null ? "direct" : `#${pr}`} ${title}`;

/** One line per commit that needs a person, with its reasons and the fork features it touches. */
export function summarizeSurvey(entries: ReadonlyArray<SurveyEntry>): string {
  const count = (status: SurveyEntry["status"]) =>
    entries.filter((entry) => entry.status === status).length;
  const parts = [
    `Surveyed ${entries.length} commits: ${count("clean")} clean, ${count("resolved")} resolved, ${count("needs-person")} need a person.`,
  ];
  for (const entry of entries.filter((candidate) => candidate.status === "needs-person")) {
    parts.push(`\n${describeCommit(entry.sha, entry.pr, entry.title)}`);
    for (const reason of entry.reasons) parts.push(`    ${reason}`);
    if (entry.features.length > 0) parts.push(`    fork features: ${entry.features.join(", ")}`);
  }
  const lint = entries.filter((entry) => entry.changesLint === true);
  if (lint.length > 0) {
    parts.push(
      "\nThese change lint rules or their configuration; lint the whole repository on the clean picks before assembly, and give fork-code violations their own track:",
    );
    for (const entry of lint) parts.push(`  ${describeCommit(entry.sha, entry.pr, entry.title)}`);
  }
  const fixed = entries.filter((entry) => entry.laterFixes.length > 0);
  if (fixed.length > 0) {
    parts.push(
      "\nLater upstream fixes name these commits; extend the batch, import the fix early, or port it before landing:",
    );
    for (const entry of fixed) {
      parts.push(`\n${describeCommit(entry.sha, entry.pr, entry.title)}`);
      for (const fix of entry.laterFixes) {
        parts.push(
          `    ${describeCommit(fix.sha, fix.pr, fix.title)}`,
          `        "${fix.evidence}"`,
        );
        if (fix.tracked !== undefined) parts.push(`        tracked: ${fix.tracked}`);
      }
    }
  }
  return `${parts.join("\n")}\n`;
}

const REVIEW_DIFF_LINES = 150;

/**
 * A review prompt scoped to the batch commits that differ from upstream, each with its fork note,
 * features, and its difference from the upstream commit it imports. Commits without a note match
 * upstream, which reviewed them, so the review skips them.
 */
function reviewBrief(cwd: string, base: string): string {
  const head = git(cwd, ["rev-parse", "HEAD"]).trim();
  const commits = lines(git(cwd, ["rev-list", "--reverse", `${base}..HEAD`]));
  const sections = commits.flatMap((sha) => {
    const message = git(cwd, ["show", "-s", "--format=%B", sha]);
    const note = forkAdaptationNote(message);
    if (note === null) return [];
    const source = [
      ...cherryPickSources(message),
      ...parseUpstreamProvenance([message]).commitShas,
    ][0];
    const subject = message.split("\n", 1)[0]!;
    const features = preservedFeatureIds(message);
    const interdiff =
      source === undefined
        ? git(cwd, ["show", "--format=", sha])
        : git(cwd, ["range-diff", "--no-color", `${source}^1..${source}`, `${sha}^..${sha}`]);
    const diffLines = interdiff.split("\n");
    const shown =
      diffLines.length > REVIEW_DIFF_LINES
        ? `${diffLines.slice(0, REVIEW_DIFF_LINES).join("\n")}\n[${diffLines.length - REVIEW_DIFF_LINES} more lines: run \`git range-diff ${source?.slice(0, 10)}^1..${source?.slice(0, 10)} ${sha.slice(0, 10)}^..${sha.slice(0, 10)}\`]`
        : interdiff;
    return [
      [
        `## ${sha.slice(0, 10)} ${subject}`,
        `Fork adaptation: ${note}`,
        ...(features.length > 0 ? [`Fork features: ${features.join(", ")}`] : []),
        source === undefined
          ? "Its full change:"
          : `How it differs from upstream ${source.slice(0, 10)} (\`git range-diff\`):`,
        "```diff",
        shown.trimEnd(),
        "```",
      ].join("\n"),
    ];
  });
  const intro = [
    `Review an upstream intake batch: ${commits.length} commits on ${base} at ${head.slice(0, 10)}, checked out at ${cwd}.`,
    "",
    `Review only the ${sections.length} commits below. Each differs from the upstream commit it imports, and its \`Fork adaptation:\` note says why. The other commits match upstream and are out of scope.`,
    "",
    "For each one, check that:",
    "- the fork behaviour named in its note and features survives; the features are entries in `.github/fork-features.yml`, whose invariants say what must hold;",
    "- upstream's change still does what upstream meant, apart from what the note explains;",
    "- the note is accurate and complete.",
    "",
    "Read the surrounding code in the checkout and run focused tests where useful. Do not edit files. Report each finding with severity (P0-P3), commit, file and line, and a concrete failure scenario. Say plainly if you find nothing.",
  ].join("\n");
  return `${intro}\n\n${sections.join("\n\n")}\n`;
}

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
 * A package's typecheck is either a package.json script or a Vite+ task in its vite.config.ts,
 * which is where packages define it when `vp run --cache` needs task-level cache inputs.
 */
export function hasTypecheckTask(packageJson: string, viteConfig: string): boolean {
  return /"typecheck"\s*:/u.test(packageJson) || /^\s*typecheck\s*:\s*\{/mu.test(viteConfig);
}

function typecheckPackages(cwd: string, changed: ReadonlyArray<string>): ReadonlyArray<string> {
  return owningPackages(cwd, changed).filter((directory) =>
    hasTypecheckTask(
      readIfExists(NodePath.join(cwd, directory, "package.json")),
      readIfExists(NodePath.join(cwd, directory, "vite.config.ts")),
    ),
  );
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
 * Packages whose config runs test files one at a time, and the parallelism verify runs them with
 * instead. One file at a time leaves most of a local machine idle for the longest step of verify.
 * Fork CI runs each server shard with three workers. On the shared 11-core intake machine, with
 * other agents holding its load average between 7 and 25, five workers ran the server tests of a
 * 55-commit batch in a median 296s against 406s with three, with no new failures.
 */
const PARALLEL_TEST_ARGS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["apps/server", ["--fileParallelism", "--maxWorkers=5"]],
]);

/**
 * The test commands verify runs, those with `PARALLEL_TEST_ARGS` first because they take longest.
 * `all` runs the `test` script of every package the batch touches, as Fork CI does. `related` runs
 * only the given test files through the owning package's `vp test run` script, so its config and
 * flags still apply; a package whose test script is anything else runs that script whole.
 */
export function plannedTestRuns(input: {
  readonly mode: "related" | "all";
  readonly touchedPackages: ReadonlyArray<string>;
  readonly testScripts: ReadonlyMap<string, string>;
  readonly relatedTests: ReadonlyArray<string>;
}): ReadonlyArray<PlannedTestRun> {
  const longestFirst = (runs: ReadonlyArray<PlannedTestRun>) =>
    runs.toSorted(
      (left, right) =>
        Number(PARALLEL_TEST_ARGS.has(right.directory)) -
        Number(PARALLEL_TEST_ARGS.has(left.directory)),
    );
  if (input.mode === "all") {
    return longestFirst(
      input.touchedPackages
        .filter((directory) => input.testScripts.has(directory))
        .map((directory) => ({
          name: `tests ${directory}`,
          directory,
          command: "pnpm",
          args: [
            "run",
            "test",
            ...(input.testScripts.get(directory)?.trim().startsWith("vp test run")
              ? (PARALLEL_TEST_ARGS.get(directory) ?? [])
              : []),
          ],
        })),
    );
  }
  const byPackage = new Map<string, Array<string>>();
  for (const path of input.relatedTests) {
    const directory = [...input.testScripts.keys()]
      .filter((candidate) => path.startsWith(`${candidate}/`))
      .toSorted((left, right) => right.length - left.length)[0];
    if (directory === undefined) continue;
    byPackage.set(directory, [...(byPackage.get(directory) ?? []), path]);
  }
  return longestFirst(
    [...byPackage]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([directory, paths]) => {
        const tests = paths.map((path) => path.slice(directory.length + 1));
        const script = (input.testScripts.get(directory) ?? "").trim().split(/\s+/u);
        const name = `tests ${directory} (${tests.length} related file${tests.length === 1 ? "" : "s"})`;
        const parallel = PARALLEL_TEST_ARGS.get(directory) ?? [];
        return script.slice(0, 3).join(" ") === "vp test run"
          ? { name, directory, command: "vp", args: [...script.slice(1), ...parallel, ...tests] }
          : { name, directory, command: "pnpm", args: ["run", "test"] };
      }),
  );
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
 * How many verify steps run at once after install: the server tests, which take longest, and the
 * other steps one after another beside them. Running more at once saturates an 11-core machine
 * and times out browser tests.
 */
const VERIFY_CONCURRENCY = 2;

/**
 * Installs once, then typechecks every package the batch touches, lints its changed files, runs
 * the tests related to the batch (the whole suite of every touched package with `allTests`),
 * checks formatting, and checks the ledger. Steps after install only read the tree, so they run
 * side by side, longest first. Prints one line per step as it finishes, with its wall time, and
 * the failing lines of each failed step.
 * Whole suites run in Fork CI, which every candidate must pass before promotion.
 */
async function verify(
  cwd: string,
  base: string,
  options: { readonly allTests?: boolean; readonly quick?: boolean } = {},
): Promise<boolean> {
  const changed = lines(git(cwd, ["diff", "--name-only", "--no-renames", `${base}...HEAD`])).filter(
    (path) => !path.startsWith(".repos/") && NodeFS.existsSync(NodePath.join(cwd, path)),
  );
  const packages = typecheckPackages(cwd, changed);
  const env = verificationEnvironment(process.env);
  const started = performance.now();
  const elapsed = (since: number) => `${((performance.now() - since) / 1000).toFixed(1)}s`;
  const runStep = async (step: VerifyStep) => {
    const stepStarted = performance.now();
    const result = await runAsync(step.directory, step.command, step.args, env);
    process.stdout.write(
      `${result.status === 0 ? "ok  " : "FAIL"} ${step.name} (${elapsed(stepStarted)})\n`,
    );
    return {
      name: step.name,
      ok: result.status === 0,
      output: `${result.stdout}\n${result.stderr}`,
    };
  };
  const install = await runStep({ name: "install", directory: cwd, command: "vp", args: ["i"] });
  const testRuns = options.quick
    ? []
    : verifyTestRuns(cwd, changed, options.allTests ? "all" : "related");
  if (options.quick) process.stdout.write("--   tests skipped; Fork CI runs them\n");
  else if (testRuns.length === 0) process.stdout.write("--   no tests related to the batch\n");
  const sources = changed.filter((path) => /\.(ts|tsx|mts|mjs|js)$/u.test(path));
  const queue: Array<VerifyStep> = [
    ...testRuns.map((test) => ({ ...test, directory: NodePath.join(cwd, test.directory) })),
    ...packages.map((directory) => ({
      name: `typecheck ${directory}`,
      directory: NodePath.join(cwd, directory),
      command: "vp",
      args: ["run", "typecheck"],
    })),
    ...(sources.length > 0
      ? [
          {
            name: "lint changed files",
            directory: cwd,
            command: "vp",
            args: ["lint", "--report-unused-disable-directives", ...sources],
          },
        ]
      : []),
    // Renames and moved imports can leave lines the formatter would wrap differently.
    {
      name: "formatting",
      directory: cwd,
      command: "vp",
      args: ["fmt", "--check", "--no-error-on-unmatched-pattern", ...changed],
    },
    {
      name: "ledger",
      directory: cwd,
      command: "vp",
      args: ["run", "--filter", "@t3tools/scripts", "ledger:check"],
    },
    {
      name: "upstream product names",
      directory: cwd,
      command: "vp",
      args: ["run", "--filter", "@t3tools/scripts", "naming:check"],
    },
  ];
  const results: Array<Awaited<ReturnType<typeof runStep>>> = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: VERIFY_CONCURRENCY }, async () => {
      while (next < queue.length) {
        const index = next++;
        results[index] = await runStep(queue[index]!);
      }
    }),
  );
  const steps = [install, ...results];
  for (const failed of steps.filter((entry) => !entry.ok)) {
    const relevant = failed.output
      .split("\n")
      .filter((line) => /error|fail|×|✗/iu.test(line))
      .slice(0, 40)
      .join("\n");
    process.stdout.write(`\n--- ${failed.name}\n${relevant || failed.output.slice(-4000)}\n`);
  }
  process.stdout.write(`\nverify took ${elapsed(started)}\n`);
  return steps.every((entry) => entry.ok);
}

interface VerifyStep {
  readonly name: string;
  readonly directory: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

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
  head: ReturnType<typeof nativeFingerprints>,
  env: NodeJS.ProcessEnv,
): NativeFingerprintComparison {
  const directory = NodePath.join(
    git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(),
    "intake-fingerprint",
  );
  try {
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
  head: ReturnType<typeof nativeFingerprints> | { readonly error: string },
  env: NodeJS.ProcessEnv,
): NativeFingerprintComparison {
  if (!touchesNativeFingerprint(changed)) return "inputs unchanged";
  return "error" in head ? head : compareNativeFingerprints(cwd, base, head, env);
}

/**
 * The newest Android release and the runtime version it was built with. Both platforms build
 * from the same app version together, and only Android publishes its runtime, so it stands in
 * for what installed apps run. An OTA update from main reaches them only while main's
 * fingerprint equals it, whatever the batch itself changed.
 */
export type ShippedNativeRuntime =
  | { readonly tag: string; readonly runtimeVersion: string }
  | { readonly error: string };

const ANDROID_RELEASE_TAG = /^[0-9a-f]+\trefs\/tags\/(android-\d+(?:\.\d+)*-(\d+))$/u;

/** Picks the release with the highest versionCode from `git ls-remote --tags` output. */
export function newestAndroidReleaseTag(lsRemote: string): string | undefined {
  let newest: { readonly tag: string; readonly versionCode: number } | undefined;
  for (const line of lsRemote.split("\n")) {
    const match = ANDROID_RELEASE_TAG.exec(line.trim());
    if (!match) continue;
    const versionCode = Number(match[2]);
    if (!newest || versionCode > newest.versionCode) newest = { tag: match[1]!, versionCode };
  }
  return newest?.tag;
}

function shippedNativeRuntime(cwd: string): ShippedNativeRuntime {
  const tags = run(cwd, "git", ["ls-remote", "--tags", "origin", "refs/tags/android-*"]);
  if (tags.status !== 0) return { error: `listing release tags failed: ${tags.stderr.trim()}` };
  const tag = newestAndroidReleaseTag(tags.stdout);
  if (!tag) return { error: "no Android release found" };
  // .github/scripts/publish-android-release.sh attaches this manifest to every release.
  const manifest = run(cwd, "curl", [
    "-fsSL",
    "--max-time",
    "30",
    `https://github.com/incognitojam/styal/releases/download/${tag}/android-update.json`,
  ]);
  if (manifest.status !== 0) {
    return { error: `reading ${tag}'s android-update.json failed: ${manifest.stderr.trim()}` };
  }
  try {
    const { runtimeVersion } = JSON.parse(manifest.stdout) as { runtimeVersion?: unknown };
    if (typeof runtimeVersion === "string" && runtimeVersion.length > 0) {
      return { tag, runtimeVersion };
    }
  } catch {}
  return { error: `${tag}'s android-update.json has no runtime version` };
}

/** Whether OTA updates from main reach installed apps once the batch is promoted. */
export function describeShippedNativeRuntime(
  shipped: ShippedNativeRuntime,
  headAndroid: string | { readonly error: string },
): string {
  if ("error" in shipped) {
    return `Installed apps: not compared (${shipped.error}). Compare main with the latest production build by hand.`;
  }
  if (typeof headAndroid !== "string") {
    return `Installed apps: not compared (${headAndroid.error}). Compare main with ${shipped.tag} by hand.`;
  }
  if (headAndroid === shipped.runtimeVersion) {
    return `Installed apps: the batch matches ${shipped.tag}'s fingerprint, so OTA updates from main reach the latest production build.`;
  }
  return `Installed apps: the batch's Android fingerprint (${headAndroid.slice(0, 10)}) differs from ${shipped.tag}'s (${shipped.runtimeVersion.slice(0, 10)}), so after promotion OTA updates from main do not reach installed apps, even if this batch did not move it, until Mobile EAS Production finishes the builds it starts for that fingerprint.`;
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
  return `Native fingerprint: moved on ${platforms} (${moved.map((entry) => `${entry.base.slice(0, 10)} → ${entry.head.slice(0, 10)}`).join(", ")}). After promotion, OTA updates no longer reach installed ${platforms} apps until the production builds Mobile EAS Production starts for the new fingerprint finish.`;
}

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
  const packages = typecheckPackages(cwd, changed);
  const fileSource = new Map<string, string>();
  let remaining: Array<string> = [];
  for (let round = 0; round < 6; round += 1) {
    remaining = [];
    let fixed = 0;
    for (const directory of packages) {
      const result = run(NodePath.join(cwd, directory), "vp", ["run", "typecheck"]);
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

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
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
      const lockfilePending = unmergedFiles(cwd).some((file) => file.path === LOCKFILE);
      if (lockfilePending && unmergedFiles(cwd).some((file) => MANIFEST.test(file.path))) {
        throw new Error("Resolve and stage the package manifests first.");
      }
      // The pick skips pinning while its workspace file holds conflicts; pins already made are
      // found in place, so this adds nothing for them.
      const pins = pinPatchedPackages(cwd, state.current.entry.sha);
      if (lockfilePending || pins.length > 0) {
        if (lockfilePending) git(cwd, ["checkout", "--ours", "--", LOCKFILE]);
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
          ...pins,
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
      process.exitCode = (await autoBatch(cwd, {
        branch,
        max,
        push: process.argv.includes("--push"),
        holdQueued: process.argv.includes("--hold-queued"),
        rerere: !process.argv.includes("--no-rerere"),
      }))
        ? 0
        : 2;
      return;
    }
    case "push": {
      const branch = git(cwd, ["branch", "--show-current"]).trim();
      if (!branch.startsWith("intake/"))
        throw new Error("push needs an intake/ branch checked out.");
      process.exitCode = (await pushCandidate(cwd, branch, {
        holdQueued: process.argv.includes("--hold-queued"),
      }))
        ? 0
        : 2;
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
    case "review-brief": {
      const brief = reviewBrief(cwd, flag("--base") ?? "origin/main");
      const out = flag("--out");
      if (out) {
        NodeFS.writeFileSync(out, brief);
        process.stdout.write(`Wrote ${out}.\n`);
      } else {
        process.stdout.write(brief);
      }
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
      process.exitCode = (await verify(cwd, flag("--base") ?? "origin/main", {
        allTests: process.argv.includes("--all-tests"),
        quick: process.argv.includes("--quick"),
      }))
        ? 0
        : 1;
      return;
    }
    case "fingerprint": {
      const base = flag("--base") ?? "origin/main";
      const changed = lines(git(cwd, ["diff", "--name-only", "--no-renames", `${base}...HEAD`]));
      const env = verificationEnvironment(process.env);
      let head: ReturnType<typeof nativeFingerprints> | { readonly error: string };
      try {
        head = nativeFingerprints(cwd, env);
      } catch (error) {
        head = { error: error instanceof Error ? error.message : String(error) };
      }
      const comparison = nativeFingerprintComparison(cwd, base, changed, head, env);
      const headAndroid =
        "error" in head ? head : head.find((entry) => entry.platform === "android")!.hash;
      const report = `${describeNativeFingerprint(comparison)}\n\n${describeShippedNativeRuntime(shippedNativeRuntime(cwd), headAndroid)}`;
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
        "Usage: intake-run.ts apply (--count <n> | --through <sha> | --commits <sha,...>) [--branch <name>] | continue [--note <text>] [--feature <ids>] | auto --branch <name> [--max <n>] [--push] [--hold-queued] [--no-rerere] | push [--hold-queued] | survey [--base <ref>] [--count <n> | --through <sha>] [--json] | review-brief [--base <ref>] [--out <file>] | fix-trailers [--base <ref>] | verify [--base <ref>] [--all-tests | --quick] | fingerprint [--base <ref>] [--json] | replay <candidate-sha> [--base <sha>] [--skip-lockfile] [--json] [--dump <dir>] | score <dump-dir> [--exclude <sha-prefixes>] [--verbose]\n",
      );
      process.exitCode = command === undefined ? 0 : 1;
  }
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
