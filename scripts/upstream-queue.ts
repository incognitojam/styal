#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - Local, synchronous maintainer CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import {
  assessEarlyCandidates,
  earlierSourcesTouching,
  resolveEarlyDependencies,
} from "./upstream-early.ts";
import { parseUpstreamProvenance, withoutFencedExamples } from "./upstream-provenance.ts";
import {
  decodeTrackedPRs,
  fetchTrackedPRMetadata,
  trackedPRStatuses,
} from "./upstream-tracked-prs.ts";

export interface IntakeState {
  upstreamRepository: string;
  baseline: string;
  target: string;
  exceptions: Record<
    string,
    { disposition: "already present" | "skip" | "pending"; reason: string }
  >;
}

export interface Integration {
  sha: string;
  parents: string[];
  title: string;
  empty: boolean;
  pr: number | null;
}

export interface QueueEntry extends Integration {
  evidence: string[];
  disposition: "pending" | "recorded" | "already present" | "skip";
}

type Run = (command: string, args: string[]) => string;

const fullSha = /^[0-9a-f]{40}$/u;

/** Let Git choose the shortest object name that remains unambiguous in this repository. */
export function shortenCommitSha(sha: string, run: Run): string {
  const shortSha = run("git", ["rev-parse", "--short", "--verify", `${sha}^{commit}`]).trim();
  if (!/^[0-9a-f]{4,40}$/u.test(shortSha))
    throw new Error(`Git returned an invalid abbreviated commit SHA for ${sha}.`);
  return shortSha;
}

/** Keep caches shared by linked worktrees and ignored, including in fresh CI checkouts. */
export function ensureScratchDirectory(root: string): string {
  const commonGitDirectory = NodeChildProcess.execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: root, encoding: "utf8" },
  ).trim();
  const checkoutRoot = NodePath.dirname(commonGitDirectory);
  const ignored = NodeChildProcess.spawnSync("git", ["check-ignore", "-q", ".scratch/"], {
    cwd: checkoutRoot,
    encoding: "utf8",
  });
  if (ignored.status === 1) {
    const exclude = NodeChildProcess.execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
      { cwd: checkoutRoot, encoding: "utf8" },
    ).trim();
    NodeFS.mkdirSync(NodePath.dirname(exclude), { recursive: true });
    NodeFS.appendFileSync(exclude, "\n/.scratch/\n");
  } else if (ignored.status !== 0) {
    throw ignored.error ?? new Error(ignored.stderr || "Could not check scratch ignore rules.");
  }
  const scratch = NodePath.resolve(checkoutRoot, ".scratch");
  NodeFS.mkdirSync(scratch, { recursive: true });
  return scratch;
}

export function decodeState(input: string): IntakeState {
  const state = JSON.parse(input) as IntakeState;
  if (
    !state ||
    typeof state.upstreamRepository !== "string" ||
    !/^[\w.-]+\/[\w.-]+$/u.test(state.upstreamRepository) ||
    typeof state.baseline !== "string" ||
    !fullSha.test(state.baseline) ||
    typeof state.target !== "string" ||
    !fullSha.test(state.target) ||
    !state.exceptions ||
    typeof state.exceptions !== "object" ||
    Array.isArray(state.exceptions)
  )
    throw new Error(
      "Invalid intake state: require repository, full baseline/target SHAs, and exceptions.",
    );
  for (const [sha, decision] of Object.entries(state.exceptions)) {
    if (
      !fullSha.test(sha) ||
      !decision ||
      !["already present", "skip", "pending"].includes(decision.disposition) ||
      typeof decision.reason !== "string" ||
      !decision.reason.trim()
    ) {
      throw new Error(`Invalid exception ${sha}: require a full SHA, disposition, and reason.`);
    }
  }
  return state;
}

/** A selected source whose patch does not apply at the reconciled upstream boundary. */
class BoundaryConflictError extends Error {
  readonly entry: QueueEntry;
  readonly paths: string[];

  constructor(entry: QueueEntry, paths: string[]) {
    super(
      `Selected ${entry.pr === null ? entry.sha : `#${entry.pr}`} cannot be applied at the upstream boundary.`,
    );
    this.entry = entry;
    this.paths = paths;
  }
}

const BOUNDARY_REPORT_LIMIT = 20;

/** Explains which files block a selected source and which pending upstream work changes them. */
function reportBoundaryConflict(input: {
  fork: string;
  through: string;
  target: string;
  blocked: QueueEntry;
  paths: readonly string[];
  earlier: readonly QueueEntry[];
  json: boolean;
  shortSha: (sha: string) => string;
}): void {
  const { shortSha } = input;
  const label = (entry: QueueEntry) => (entry.pr === null ? shortSha(entry.sha) : `#${entry.pr}`);
  if (input.json) {
    console.log(
      JSON.stringify(
        {
          fork: input.fork,
          through: input.through,
          target: input.target,
          blockedAt: { sha: input.blocked.sha, pr: input.blocked.pr },
          conflictedPaths: input.paths,
          earlierSources: input.earlier.map((entry) => ({
            sha: entry.sha,
            pr: entry.pr,
            title: entry.title,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  const prs = new Set(input.earlier.flatMap((entry) => (entry.pr === null ? [] : [entry.pr])));
  const direct = input.earlier.filter((entry) => entry.pr === null).length;
  console.log(`Fork ${shortSha(input.fork)}; reconciled through ${shortSha(input.through)}`);
  console.log(
    `${label(input.blocked)} does not apply at the reconciled boundary. ${input.paths.length} of its files conflict there:`,
  );
  for (const path of input.paths) console.log(`  ${path}`);
  if (input.earlier.length === 0) {
    console.log("No earlier pending upstream change touches those files.");
    return;
  }
  console.log(
    `Earlier pending upstream changes to those files: ${prs.size} PRs${direct ? ` and ${direct} direct commits` : ""}. Take them in first, or add their PRs to this plan.`,
  );
  const shown = new Set<string>();
  for (const entry of input.earlier) {
    const key = entry.pr === null ? entry.sha : `#${entry.pr}`;
    if (shown.has(key)) continue;
    if (shown.size === BOUNDARY_REPORT_LIMIT) {
      console.log(`  ... ${prs.size + direct - shown.size} more; --json lists every source.`);
      break;
    }
    shown.add(key);
    console.log(`  ${label(entry)} ${entry.title}`);
  }
}

/** Reconcile against fork main only; a source trailer records an import, not patch equivalence. */
export function reconcile(
  integrations: Integration[],
  forkCommits: { sha: string; message: string }[],
  exceptions: IntakeState["exceptions"],
): QueueEntry[] {
  const commits = new Map<string, string[]>();
  const prs = new Map<number, string[]>();
  const add = <K>(map: Map<K, string[]>, key: K, evidence: string) =>
    map.set(key, [...(map.get(key) ?? []), evidence]);
  for (const commit of forkCommits) {
    add(commits, commit.sha, `ancestor of fork main: ${commit.sha}`);
    const provenance = parseUpstreamProvenance([commit.message]);
    if (provenance.errors.length) throw new Error(`${commit.sha}: ${provenance.errors.join(" ")}`);
    for (const sha of provenance.commitShas) add(commits, sha, `Upstream-Commit in ${commit.sha}`);
    for (const pr of provenance.pullRequestNumbers) add(prs, pr, `PR provenance in ${commit.sha}`);
    for (const match of withoutFencedExamples(commit.message).matchAll(
      /\(cherry picked from commit ([0-9a-f]{40})\)/gu,
    )) {
      add(commits, match[1]!, `cherry-pick -x in ${commit.sha}`);
    }
  }
  return integrations.map((integration) => {
    const exception = exceptions[integration.sha];
    const evidence = [
      ...(commits.get(integration.sha) ?? []),
      ...(integration.pr === null ? [] : (prs.get(integration.pr) ?? [])),
    ];
    if (exception) evidence.push(`${exception.disposition}: ${exception.reason}`);
    return {
      ...integration,
      evidence,
      disposition: exception?.disposition ?? (evidence.length ? "recorded" : "pending"),
    };
  });
}

/** Include direct commits through the boundary before the next outstanding PR. */
export function nextBatch(entries: QueueEntry[], count: number): QueueEntry[] {
  if (!Number.isSafeInteger(count) || count < 1)
    throw new Error("Count must be a positive integer.");
  const prs = new Set<number>();
  const batch: QueueEntry[] = [];
  for (const entry of entries) {
    if (entry.disposition !== "pending") continue;
    if (entry.pr !== null && !prs.has(entry.pr)) {
      if (prs.size === count) break;
      prs.add(entry.pr);
    }
    batch.push(entry);
  }
  const selected = new Set(batch.map((entry) => entry.sha));
  if (
    entries.some(
      (entry) =>
        entry.disposition === "pending" &&
        entry.pr !== null &&
        prs.has(entry.pr) &&
        !selected.has(entry.sha),
    )
  )
    throw new Error(
      "Batch boundary splits an interleaved PR. Increase --count to include its complete range.",
    );
  return batch;
}

export function reconciledThrough(baseline: string, entries: QueueEntry[]): string {
  let through = baseline;
  for (const entry of entries) {
    if (entry.disposition === "pending") break;
    through = entry.sha;
  }
  return through;
}

export function advanceBaseline(
  state: IntakeState,
  entries: QueueEntry[],
  source: string,
): IntakeState {
  const index = entries.findIndex((entry) => entry.sha === source);
  if (index < 0 || entries.slice(0, index + 1).some((entry) => entry.disposition === "pending"))
    throw new Error("Cannot advance past an unresolved commit or outside the current range.");
  const crossedPRs = new Set(
    entries.slice(0, index + 1).flatMap((entry) => (entry.pr === null ? [] : [entry.pr])),
  );
  if (entries.slice(index + 1).some((entry) => entry.pr !== null && crossedPRs.has(entry.pr)))
    throw new Error("Cannot advance into the middle of a PR.");
  return { ...state, baseline: source };
}

/** Require both boundaries on the first-parent chain; ancestry alone admits side branches. */
export function readIntegrations(state: IntakeState, run: Run): Integration[] {
  const chain = run("git", ["rev-list", "--first-parent", state.target]).trim().split("\n");
  if (!chain.includes(state.baseline))
    throw new Error("Baseline is not on target's first-parent chain.");
  let previousTree = run("git", ["rev-parse", `${state.baseline}^{tree}`]).trim();
  const log = run("git", [
    "log",
    "--first-parent",
    "--reverse",
    "--format=%H%x09%T%x09%P%x09%s",
    `${state.baseline}..${state.target}`,
  ]).trim();
  return (log ? log.split("\n") : []).map((line) => {
    const [sha, tree, parents, ...title] = line.split("\t");
    if (!sha || !tree || !parents) throw new Error("Could not parse upstream history.");
    const empty = tree === previousTree;
    previousTree = tree;
    return { sha, parents: parents.split(" "), title: title.join("\t"), empty, pr: null };
  });
}

interface AssociatedPR {
  number: number;
  mergedAt: string | null;
  baseRefName: string;
  baseRepository: { nameWithOwner: string };
  mergeCommit: { oid: string } | null;
}
type Associations = Record<string, AssociatedPR[]>;

/** Reuse settled PR associations across targets; retry direct and unmerged commits. */
export function reusableAssociations(
  cache: Associations,
  repository: string,
  targetChain: ReadonlySet<string>,
): Associations {
  return Object.fromEntries(
    Object.entries(cache).filter(([, prs]) =>
      prs.some(
        (pr) =>
          pr.mergedAt !== null &&
          pr.baseRepository.nameWithOwner === repository &&
          pr.mergeCommit !== null &&
          targetChain.has(pr.mergeCommit.oid),
      ),
    ),
  );
}

export function associatePRs(
  integrations: Integration[],
  associations: Associations,
  repository: string,
  chain: Set<string>,
): Integration[] {
  return integrations.map((entry) => {
    const prs = associations[entry.sha];
    if (!prs) throw new Error(`Missing GitHub metadata for ${entry.sha}.`);
    // A PR can merge into an intermediate branch before its commits reach main.
    // The target's first-parent chain, not the PR's base branch name, establishes coverage.
    const merged = prs.filter(
      (pr) => pr.mergedAt !== null && pr.baseRepository.nameWithOwner === repository,
    );
    if (merged.some((pr) => !pr.mergeCommit || !chain.has(pr.mergeCommit.oid))) {
      throw new Error(
        `PR association for ${entry.sha} ends outside target history. Choose a target after the complete PR, or inspect its merge history.`,
      );
    }
    if (merged.length > 1)
      throw new Error(
        `Ambiguous merged PR associations for ${entry.sha}; inspect upstream history.`,
      );
    return { ...entry, pr: merged[0]?.number ?? null };
  });
}

export function fetchAssociations(
  integrations: ReadonlyArray<Pick<Integration, "sha">>,
  repository: string,
  cache: Associations,
  run: Run,
  persist: (associations: Associations) => void = () => undefined,
): Associations {
  const missing = integrations.filter((entry) => cache[entry.sha] === undefined);
  const [owner, name] = repository.split("/");
  for (let start = 0; start < missing.length; start += 40) {
    const batch = missing.slice(start, start + 40);
    console.error(
      `Reading upstream PR metadata: ${Math.min(start + 40, missing.length)}/${missing.length}`,
    );
    const query = `query { repository(owner:${JSON.stringify(owner)}, name:${JSON.stringify(name)}) { ${batch.map((entry, index) => `c${index}: object(oid:"${entry.sha}") { ... on Commit { associatedPullRequests(first:100) { nodes { number mergedAt baseRefName baseRepository { nameWithOwner } mergeCommit { oid } } pageInfo { hasNextPage } } } }`).join("\n")} } }`;
    const response = JSON.parse(run("gh", ["api", "graphql", "-f", `query=${query}`])) as {
      errors?: unknown;
      data: {
        repository: Record<
          string,
          { associatedPullRequests: { nodes: AssociatedPR[]; pageInfo: { hasNextPage: boolean } } }
        >;
      };
    };
    if (response.errors || !response.data?.repository)
      throw new Error("Could not read complete GitHub PR metadata.");
    batch.forEach((entry, index) => {
      const result = response.data.repository[`c${index}`]?.associatedPullRequests;
      if (!result || result.pageInfo.hasNextPage)
        throw new Error(`Incomplete PR associations for ${entry.sha}.`);
      cache[entry.sha] = result.nodes;
    });
    persist(cache);
  }
  return cache;
}

function writeAssociationsCache(path: string, associations: Associations): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporaryPath, `${JSON.stringify(associations)}\n`);
  NodeFS.renameSync(temporaryPath, path);
}

function main() {
  const { values, positionals } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: {
      count: { type: "string", default: "20" },
      state: { type: "string", default: ".github/upstream-intake.json" },
      "fork-ref": { type: "string", default: "origin/main" },
      "upstream-ref": { type: "string", default: "upstream/main" },
      through: { type: "string" },
      json: { type: "boolean" },
      "refresh-metadata": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const [command = "status", source] = positionals;
  if (values.help) {
    console.log(
      "Usage: node scripts/upstream-queue.ts status|next|explain <PR-or-SHA> [--count 20] [--json] [--refresh-metadata]\n       node scripts/upstream-queue.ts early [PR ...] [--count 20] [--through upstream/main] [--json]\n       node scripts/upstream-queue.ts advance <SHA> | target <SHA>\nReads .github/upstream-intake.json and fetched origin/main, upstream/main. Status also reports .github/upstream-tracked-prs.json. No fetch, checkout, cherry-pick, or GitHub writes. advance/target edit only the local state file.",
    );
    return;
  }
  if (
    !["status", "next", "explain", "early", "advance", "target"].includes(command) ||
    (positionals.length > 2 && command !== "early")
  )
    throw new Error("Unknown command or extra arguments. Use --help.");
  if (["explain", "advance", "target"].includes(command) && !source)
    throw new Error(`${command} requires a PR or commit.`);
  if (["status", "next"].includes(command) && source)
    throw new Error(`${command} does not accept a positional argument.`);
  if (values.through && command !== "early")
    throw new Error("--through is only available for early assessments.");
  const requestedPRs =
    command === "early"
      ? positionals
          .slice(1)
          .flatMap((value) => value.split(","))
          .map((value) => {
            if (!/^#?[1-9]\d*$/u.test(value)) throw new Error("early accepts PR numbers.");
            return Number(value.replace("#", ""));
          })
      : [];
  const count = Number(values.count);
  if (!Number.isSafeInteger(count) || count < 1)
    throw new Error("Count must be a positive integer.");
  const root = NodePath.resolve(import.meta.dirname, "..");
  const run: Run = (cmd, args) =>
    NodeChildProcess.execFileSync(cmd, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  const shortShas = new Map<string, string>();
  const shortSha = (sha: string) => {
    const cached = shortShas.get(sha);
    if (cached) return cached;
    const abbreviated = shortenCommitSha(sha, run);
    shortShas.set(sha, abbreviated);
    return abbreviated;
  };
  const abbreviateShas = (text: string) => text.replace(/[0-9a-f]{40}/gu, shortSha);
  const statePath = NodePath.resolve(root, values.state);
  const state = decodeState(NodeFS.readFileSync(statePath, "utf8"));
  const fork = run("git", [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${values["fork-ref"]}^{commit}`,
  ]).trim();
  const upstream = run("git", [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${values["upstream-ref"]}^{commit}`,
  ]).trim();
  if (values.through) {
    state.target = run("git", [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${values.through}^{commit}`,
    ]).trim();
  }
  const upstreamChain = run("git", ["rev-list", "--first-parent", upstream]).trim().split("\n");
  if (!upstreamChain.includes(state.target))
    throw new Error("Target is not on fetched upstream main's first-parent chain.");
  if (command === "target") {
    if (state.baseline !== state.target)
      throw new Error("Finish and advance to the current target before choosing another.");
    if (
      !source ||
      !fullSha.test(source) ||
      !upstreamChain.includes(source) ||
      upstreamChain.indexOf(source) > upstreamChain.indexOf(state.target)
    )
      throw new Error("New target must be a full SHA at or after the old target on upstream main.");
    state.target = source;
  }
  const integrations = readIntegrations(state, run);
  const targetChain = new Set(
    run("git", ["rev-list", "--first-parent", state.target]).trim().split("\n"),
  );
  const scratch = ensureScratchDirectory(root);
  const cacheName = `upstream-queue-${state.upstreamRepository.replace("/", "-")}-${state.target}-prs.json`;
  const cachePath = NodePath.resolve(scratch, cacheName);
  const worktreeCachePath = NodePath.resolve(root, ".scratch", cacheName);
  const otherCachePaths = [scratch, NodePath.resolve(root, ".scratch")].flatMap((directory) =>
    NodeFS.existsSync(directory)
      ? NodeFS.readdirSync(directory)
          .filter(
            (name) =>
              name.startsWith(`upstream-queue-${state.upstreamRepository.replace("/", "-")}-`) &&
              name.endsWith("-prs.json"),
          )
          .map((name) => NodePath.resolve(directory, name))
      : [],
  );
  const readCache = (path: string) => JSON.parse(NodeFS.readFileSync(path, "utf8")) as Associations;
  const currentCachePath = [cachePath, worktreeCachePath].find((path) => NodeFS.existsSync(path));
  const cache = !values["refresh-metadata"] && currentCachePath ? readCache(currentCachePath) : {};
  if (!values["refresh-metadata"]) {
    for (const path of otherCachePaths) {
      if (path === currentCachePath) continue;
      const reusable = reusableAssociations(readCache(path), state.upstreamRepository, targetChain);
      for (const [sha, prs] of Object.entries(reusable)) cache[sha] ??= prs;
    }
  }
  writeAssociationsCache(cachePath, cache);
  const associations = fetchAssociations(
    integrations,
    state.upstreamRepository,
    cache,
    run,
    (next) => writeAssociationsCache(cachePath, next),
  );
  writeAssociationsCache(cachePath, associations);
  const associated = associatePRs(
    integrations,
    associations,
    state.upstreamRepository,
    targetChain,
  );
  if (command === "target") {
    NodeFS.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    console.log(`Target set to ${shortSha(state.target)}`);
    return;
  }
  const forkLog = run("git", ["log", "--format=%H%x00%B%x00", fork]).split("\0");
  const forkCommits: { sha: string; message: string }[] = [];
  for (let index = 0; index + 1 < forkLog.length; index += 2)
    forkCommits.push({ sha: forkLog[index]!.trim(), message: forkLog[index + 1]! });
  const entries = reconcile(associated, forkCommits, state.exceptions);
  const through = reconciledThrough(state.baseline, entries);
  if (command === "early") {
    const localScratch = NodePath.resolve(root, ".scratch");
    const ignored = NodeChildProcess.spawnSync("git", ["check-ignore", "-q", ".scratch/"], {
      cwd: root,
    });
    if (ignored.status === 1) {
      const exclude = run("git", [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "info/exclude",
      ]).trim();
      NodeFS.appendFileSync(exclude, "\n/.scratch/\n");
    } else if (ignored.status !== 0) {
      throw ignored.error ?? new Error("Could not check scratch ignore rules.");
    }
    NodeFS.mkdirSync(localScratch, { recursive: true });
    const objectDirectory = NodeFS.mkdtempSync(
      NodePath.resolve(localScratch, "upstream-early-objects-"),
    );
    const commonObjects = run("git", [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ]).trim();
    const simulationEnv = {
      ...process.env,
      GIT_OBJECT_DIRECTORY: objectDirectory,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [
        commonObjects,
        process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
      ]
        .filter(Boolean)
        .join(NodePath.delimiter),
    };
    try {
      const changedPaths = new Map<string, string[]>();
      const pathsFor = (entry: QueueEntry) => {
        const cached = changedPaths.get(entry.sha);
        if (cached) return cached;
        const paths = run("git", [
          "diff",
          "--name-only",
          "--no-renames",
          "-z",
          entry.parents[0]!,
          entry.sha,
        ])
          .split("\0")
          .filter(Boolean);
        changedPaths.set(entry.sha, paths);
        return paths;
      };
      const appliesCleanly = (entry: QueueEntry) => {
        const result = NodeChildProcess.spawnSync(
          "git",
          ["merge-tree", "--write-tree", `--merge-base=${entry.parents[0]}`, fork, entry.sha],
          { cwd: root, encoding: "utf8", env: simulationEnv },
        );
        if (result.status === 0) return true;
        if (result.status === 1) return false;
        throw result.error ?? new Error(result.stderr || "Could not simulate cherry-pick.");
      };
      if (requestedPRs.length) {
        const applyPatch = (current: string, entry: QueueEntry): string | null => {
          const result = NodeChildProcess.spawnSync(
            "git",
            ["merge-tree", "--write-tree", `--merge-base=${entry.parents[0]}`, current, entry.sha],
            { cwd: root, encoding: "utf8", env: simulationEnv },
          );
          if (result.status === 1) return null;
          if (result.status !== 0)
            throw result.error ?? new Error(result.stderr || "Could not simulate intake plan.");
          const tree = result.stdout.split("\n")[0]!;
          if (!fullSha.test(tree)) throw new Error("Git did not return a merge tree.");
          return tree;
        };
        /** Paths `git merge-tree` reports as conflicting when applying `entry` onto `current`. */
        const conflictedPaths = (current: string, entry: QueueEntry): string[] => {
          const result = NodeChildProcess.spawnSync(
            "git",
            [
              "merge-tree",
              "--write-tree",
              "--name-only",
              "--no-messages",
              `--merge-base=${entry.parents[0]}`,
              current,
              entry.sha,
            ],
            { cwd: root, encoding: "utf8", env: simulationEnv },
          );
          return [...new Set(result.stdout.split("\n").slice(1).filter(Boolean))];
        };
        const syntheticCommit = (tree: string, parent: string) =>
          NodeChildProcess.execFileSync(
            "git",
            ["commit-tree", tree, "-p", parent, "-m", "Synthetic intake assessment"],
            {
              cwd: root,
              encoding: "utf8",
              env: {
                ...simulationEnv,
                GIT_AUTHOR_NAME: "Intake check",
                GIT_AUTHOR_EMAIL: "intake-check@example.invalid",
                GIT_COMMITTER_NAME: "Intake check",
                GIT_COMMITTER_EMAIL: "intake-check@example.invalid",
              },
            },
          ).trim();
        const treeOf = (ref: string) =>
          NodeChildProcess.execFileSync("git", ["rev-parse", `${ref}^{tree}`], {
            cwd: root,
            encoding: "utf8",
            env: simulationEnv,
          }).trim();
        let plan: ReturnType<typeof resolveEarlyDependencies>;
        try {
          plan = resolveEarlyDependencies(
            entries,
            state.baseline,
            through,
            requestedPRs,
            (selection) => {
              let overlay = through;
              for (const entry of selection.selected) {
                const tree = applyPatch(overlay, entry);
                if (tree === null)
                  throw new BoundaryConflictError(entry, conflictedPaths(overlay, entry));
                overlay = syntheticCommit(tree, overlay);
              }
              const selected = new Set(selection.selected.map((entry) => entry.sha));
              for (const entry of selection.intervening) {
                if (selected.has(entry.sha)) {
                  overlay = syntheticCommit(treeOf(overlay), entry.sha);
                  continue;
                }
                const tree = applyPatch(overlay, entry);
                if (tree === null) return entry;
                overlay = syntheticCommit(tree, entry.sha);
              }
              const finalSource = selection.intervening.at(-1)!;
              if (treeOf(overlay) !== treeOf(finalSource.sha))
                throw new Error("Replay changed the upstream result without a textual conflict.");
              return null;
            },
          );
        } catch (error) {
          if (!(error instanceof BoundaryConflictError)) throw error;
          reportBoundaryConflict({
            fork,
            through,
            target: state.target,
            blocked: error.entry,
            paths: error.paths,
            earlier: earlierSourcesTouching(
              entries,
              state.baseline,
              through,
              error.entry,
              error.paths,
              pathsFor,
            ),
            json: values.json === true,
            shortSha,
          });
          process.exitCode = 1;
          return;
        }
        let current = fork;
        let forkConflict: QueueEntry | null = null;
        for (const entry of plan.selected) {
          const tree = applyPatch(current, entry);
          if (tree === null) {
            forkConflict = entry;
            break;
          }
          current = syntheticCommit(tree, current);
        }
        const summary = {
          fork,
          through,
          target: state.target,
          requestedPRs: plan.requestedPRs,
          dependencyPRs: plan.dependencyPRs,
          dependencyCommits: plan.dependencyCommits,
          selectedCommits: plan.selected.map((entry) => ({ sha: entry.sha, pr: entry.pr })),
          replayedCommits: plan.replayedCommits,
          attempts: plan.attempts,
          forkAppliesCleanly: forkConflict === null,
          forkConflictAt:
            forkConflict === null ? null : { sha: forkConflict.sha, pr: forkConflict.pr },
        };
        if (values.json) console.log(JSON.stringify(summary, null, 2));
        else {
          console.log(`Fork ${shortSha(fork)}; reconciled through ${shortSha(through)}`);
          console.log(`Requested: ${plan.requestedPRs.map((pr) => `#${pr}`).join(", ")}`);
          console.log(
            `Earlier conflicting PRs to include: ${plan.dependencyPRs.length ? plan.dependencyPRs.map((pr) => `#${pr}`).join(", ") : "none"}`,
          );
          console.log(
            `Earlier direct commits to include: ${plan.dependencyCommits.length ? plan.dependencyCommits.map(shortSha).join(", ") : "none"}`,
          );
          console.log(
            forkConflict === null
              ? `${plan.selected.length} selected commits apply cleanly to fork main; ${plan.replayedCommits} upstream integrations replay without conflicts.`
              : `Selected commits conflict on fork main at ${forkConflict.pr === null ? "direct commit" : `#${forkConflict.pr}`} ${shortSha(forkConflict.sha)}.`,
          );
          console.log("Review semantic dependencies and validate behavior before importing.");
        }
        return;
      }
      const candidates = assessEarlyCandidates(
        entries,
        state.baseline,
        through,
        count,
        null,
        pathsFor,
        appliesCleanly,
      );
      if (values.json)
        console.log(JSON.stringify({ fork, through, target: state.target, candidates }, null, 2));
      else {
        console.log(
          `Fork ${shortSha(fork)}; reconciled through ${shortSha(through)}; target ${shortSha(state.target)}`,
        );
        for (const candidate of candidates) {
          const overlap = candidate.overlappingPaths.length
            ? `overlap: ${candidate.overlappingPaths.join(", ")}`
            : "no earlier pending file overlap";
          const apply =
            candidate.cleanApply === null
              ? candidate.reason
              : candidate.cleanApply
                ? "applies cleanly now"
                : "conflicts now";
          console.log(
            `${candidate.fileDisjointAndClean ? "[file-disjoint]" : "[review]"} #${candidate.pr}: ${candidate.precedingPRs} earlier pending PRs; ${overlap}; ${apply}`,
          );
        }
        console.log("Use early <PR> to replay intermediate integrations for a selected PR.");
      }
      return;
    } finally {
      NodeFS.rmSync(objectDirectory, { recursive: true, force: true });
    }
  }
  if (command === "advance") {
    const advanced = advanceBaseline(state, entries, source!);
    NodeFS.writeFileSync(statePath, `${JSON.stringify(advanced, null, 2)}\n`);
    console.log(
      `Baseline advanced to ${shortSha(advanced.baseline)}; commit the state change after reviewing the evidence.`,
    );
    return;
  }
  const pending = entries.filter((entry) => entry.disposition === "pending");
  const summary = {
    fork,
    upstream,
    baseline: state.baseline,
    target: state.target,
    reconciledThrough: through,
    totalCommits: entries.length,
    pendingCommits: pending.length,
    pendingPRs: new Set(pending.flatMap((entry) => (entry.pr === null ? [] : [entry.pr]))).size,
    pendingDirectCommits: pending.filter((entry) => entry.pr === null).length,
    recordedCommits: entries.filter((entry) => entry.disposition === "recorded").length,
    exceptions: entries.filter((entry) => Object.hasOwn(state.exceptions, entry.sha)).length,
    beyondTarget: upstreamChain.indexOf(state.target),
  };
  const tracked =
    command === "status"
      ? (() => {
          const selected = decodeTrackedPRs(
            NodeFS.readFileSync(
              NodePath.resolve(root, ".github/upstream-tracked-prs.json"),
              "utf8",
            ),
          );
          return trackedPRStatuses({
            tracked: selected,
            metadata: fetchTrackedPRMetadata(state.upstreamRepository, selected, run),
            entries,
            forkCommits,
            upstreamFirstParent: new Set(upstreamChain),
            targetFirstParent: targetChain,
            baselineFirstParent: new Set(
              run("git", ["rev-list", "--first-parent", state.baseline]).trim().split("\n"),
            ),
            exceptions: state.exceptions,
            tipMergedAt: Number(run("git", ["log", "-1", "--format=%ct", through]).trim()) * 1000,
          });
        })()
      : [];
  let selected: QueueEntry[] = [];
  if (command === "next") selected = nextBatch(entries, count);
  if (command === "explain") {
    const commitMatches = /^[0-9a-f]{7,40}$/u.test(source!)
      ? entries.filter((entry) => entry.sha.startsWith(source!))
      : [];
    const pr =
      commitMatches.length === 0 && /^#?[1-9]\d*$/u.test(source!)
        ? Number(source!.replace("#", ""))
        : null;
    selected = entries.filter((entry) =>
      pr !== null
        ? entry.pr === pr
        : /^[0-9a-f]{7,40}$/u.test(source!) && entry.sha.startsWith(source!),
    );
    if (!selected.length) throw new Error("Source is not in the baseline..target range.");
    if (pr === null && selected.length > 1)
      throw new Error("Ambiguous commit prefix; use the full SHA.");
  }
  if (values.json) console.log(JSON.stringify({ ...summary, tracked, entries: selected }, null, 2));
  else {
    console.log(
      `Fork ${shortSha(fork)}\nUpstream ${shortSha(upstream)}\nBaseline ${shortSha(state.baseline)}\nTarget ${shortSha(state.target)}\nReconciled through ${shortSha(through)}\n${pending.length}/${entries.length} commits pending (${summary.pendingPRs} PRs, ${summary.pendingDirectCommits} direct/unassociated commits); ${summary.recordedCommits} recorded, ${summary.exceptions} exceptions.\n${summary.beyondTarget} upstream commits beyond target.\nRecorded provenance is import evidence, not proof of current patch equivalence.`,
    );
    for (const entry of selected) {
      console.log(
        `${shortSha(entry.sha)} ${entry.pr === null ? "commit" : `#${entry.pr}`} [${entry.disposition}] ${entry.title}${entry.empty ? " [empty first-parent diff: inspect source history]" : ""}`,
      );
      if (command === "explain")
        for (const evidence of entry.evidence) console.log(`  ${abbreviateShas(evidence)}`);
    }
    if (command === "status" && tracked.length) {
      console.log("\nTracked upstream PRs:");
      for (const pr of tracked) {
        const gap =
          pr.daysAheadOfTip === null ? "" : `, ${pr.daysAheadOfTip.toFixed(1)}d ahead of tip`;
        const target = pr.beyondTarget ? ", beyond target" : "";
        const merged = pr.mergedAt ? `, merged ${pr.mergedAt.slice(0, 10)}` : "";
        console.log(`#${pr.number} [${pr.status}${target}${merged}${gap}] ${pr.title}`);
        console.log(`  ${pr.reason}`);
      }
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
