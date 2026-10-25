#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - Synchronous CI and maintainer CLI.
/**
 * A candidate lands by fast-forwarding main to the exact SHA Fork CI tested, so any merge in the
 * meantime forces a rebase and retest. Every open pull request gets the hold, since each stack
 * layer is checked against main's rules. See docs/operations/upstream-tracking.md.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

export const HOLD_CONTEXT = "Intake landing hold";

/** How long after Fork CI passes the hold waits for the promotion run it starts to appear. */
const PROMOTION_START_GRACE_MS = 15 * 60_000;

/**
 * How long after an intake branch's newest Fork CI run fails the hold waits for a fixed push.
 * Releasing at once would let queued auto-merges move main before the rebased candidate starts.
 */
const REPUSH_GRACE_MS = 10 * 60_000;

export interface WorkflowRun {
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly head_branch: string | null;
  readonly head_sha: string;
  readonly display_title: string;
  readonly html_url: string;
  readonly updated_at: string;
}

export interface HoldingCandidate {
  readonly branch: string;
  readonly sha: string;
  readonly url: string;
  /** When a hold that waits on a grace period ends; no event marks it, so the caller rechecks. */
  readonly until?: number;
}

const PROMOTION_TITLE = /^Promote (\S+) at ([0-9a-f]{40})$/;

/**
 * The intake candidates holding main: those whose Fork CI push run is still going, whose
 * promotion run has not finished, whose Fork CI passed so recently that its promotion run may
 * not exist yet, or whose branch's newest Fork CI run failed so recently that a fixed push may
 * not have started yet. `forkCiRuns` is newest first, as GitHub lists them.
 */
export function holdingCandidates(
  forkCiRuns: ReadonlyArray<WorkflowRun>,
  promotionRuns: ReadonlyArray<WorkflowRun>,
  now: number,
): ReadonlyArray<HoldingCandidate> {
  const holding = new Map<string, HoldingCandidate>();
  const promotions = promotionRuns.flatMap((run) => {
    const match = PROMOTION_TITLE.exec(run.display_title);
    return match ? [{ run, branch: match[1]!, sha: match[2]! }] : [];
  });
  for (const { run, branch, sha } of promotions) {
    if (run.status !== "completed") holding.set(sha, { branch, sha, url: run.html_url });
  }
  const seenBranches = new Set<string>();
  for (const run of forkCiRuns) {
    const branch = run.head_branch;
    if (run.event !== "push" || !branch?.startsWith("intake/")) continue;
    const newest = !seenBranches.has(branch);
    seenBranches.add(branch);
    if (holding.has(run.head_sha)) continue;
    const candidate = { branch, sha: run.head_sha, url: run.html_url };
    const finished = Date.parse(run.updated_at);
    if (run.status !== "completed") {
      holding.set(run.head_sha, candidate);
    } else if (
      run.conclusion === "success" &&
      now - finished < PROMOTION_START_GRACE_MS &&
      !promotions.some((promotion) => promotion.sha === run.head_sha)
    ) {
      holding.set(run.head_sha, { ...candidate, until: finished + PROMOTION_START_GRACE_MS });
    } else if (newest && run.conclusion === "failure" && now - finished < REPUSH_GRACE_MS) {
      holding.set(run.head_sha, { ...candidate, until: finished + REPUSH_GRACE_MS });
    }
  }
  return [...holding.values()];
}

export interface CommitStatus {
  readonly state: "pending" | "success";
  readonly description: string;
  readonly target_url?: string;
}

/** The status an open pull request gets while `holding` candidates are landing. */
export function pullRequestStatus(holding: ReadonlyArray<HoldingCandidate>): CommitStatus {
  const first = holding[0];
  if (!first) return { state: "success", description: "No upstream intake is landing" };
  const others = holding.length > 1 ? ` and ${holding.length - 1} more` : "";
  return {
    state: "pending",
    description: `Waiting for ${first.branch}${others} to land`.slice(0, 140),
    target_url: first.url,
  };
}

function gh(args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

interface OpenPullRequest {
  readonly number: number;
  readonly headRefOid: string;
  readonly current: { readonly state: string; readonly description: string | null } | null;
}

const OPEN_PULL_REQUESTS = `query($owner: String!, $name: String!, $context: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, after: $endCursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        headRefOid
        commits(last: 1) { nodes { commit { status { context(name: $context) { state description } } } } }
      }
    }
  }
}`;

/** Open pull requests with the hold status their head commit has now. */
function openPullRequests(repository: string): ReadonlyArray<OpenPullRequest> {
  const [owner, name] = repository.split("/");
  const output = gh([
    "api",
    "graphql",
    "--paginate",
    "--slurp",
    "-f",
    `query=${OPEN_PULL_REQUESTS}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-f",
    `context=${HOLD_CONTEXT}`,
  ]);
  const pages = JSON.parse(output) as Array<{
    data: {
      repository: {
        pullRequests: {
          nodes: Array<{
            number: number;
            headRefOid: string;
            commits: {
              nodes: Array<{
                commit: {
                  status: { context: { state: string; description: string | null } | null } | null;
                };
              }>;
            };
          }>;
        };
      };
    };
  }>;
  return pages.flatMap((page) =>
    page.data.repository.pullRequests.nodes.map((node) => ({
      number: node.number,
      headRefOid: node.headRefOid,
      current: node.commits.nodes[0]?.commit.status?.context ?? null,
    })),
  );
}

/**
 * Writes the hold status for `holding` on open pull requests whose status differs, and success on
 * each holding candidate. Statuses are read before `decide` reads workflow runs: a status written
 * after this read was written after its candidate's Fork CI run existed, so `decide` sees that
 * run and keeps the hold instead of overwriting it.
 */
export function updateLandingHold(
  repository: string,
  decide: () => ReadonlyArray<HoldingCandidate>,
  options: { readonly dryRun?: boolean } = {},
): ReadonlyArray<HoldingCandidate> {
  const pulls = openPullRequests(repository);
  const holding = decide();
  const status = pullRequestStatus(holding);
  const writes: Array<{ sha: string; label: string; status: CommitStatus }> = [
    ...holding.map((candidate) => ({
      sha: candidate.sha,
      label: candidate.branch,
      status: {
        state: "success",
        description: "Intake candidate",
        target_url: candidate.url,
      } as const,
    })),
    ...pulls
      .filter(
        (pull) =>
          pull.current?.state !== status.state.toUpperCase() ||
          pull.current.description !== status.description,
      )
      .map((pull) => ({ sha: pull.headRefOid, label: `#${pull.number}`, status })),
  ];
  console.log(
    holding.length === 0
      ? "No intake candidate is landing."
      : `Holding for ${holding.map((candidate) => `${candidate.branch} at ${candidate.sha.slice(0, 10)}`).join(", ")}.`,
  );
  for (const write of writes) {
    console.log(
      `- ${write.label} ${write.sha.slice(0, 10)}: ${write.status.state}, ${write.status.description}`,
    );
    if (options.dryRun) continue;
    gh([
      "api",
      "-X",
      "POST",
      `repos/${repository}/statuses/${write.sha}`,
      "-f",
      `context=${HOLD_CONTEXT}`,
      "-f",
      `state=${write.status.state}`,
      "-f",
      `description=${write.status.description}`,
      ...(write.status.target_url ? ["-f", `target_url=${write.status.target_url}`] : []),
    ]);
  }
  return holding;
}

/**
 * Holds open pull requests for an intake candidate just pushed, without waiting for this
 * workflow's next run to get a runner. Waits up to two minutes for the candidate's Fork CI run to
 * exist first, so a workflow run cannot read the new status and decide from runs without it.
 */
export function holdForPushedCandidate(
  repository: string,
  branch: string,
  sha: string,
  options: { readonly dryRun?: boolean } = {},
): string | null {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const url = gh([
      "api",
      `repos/${repository}/actions/workflows/fork-ci.yml/runs?head_sha=${sha}&event=push`,
      "--jq",
      ".workflow_runs[0].html_url // empty",
    ]).trim();
    if (url) {
      updateLandingHold(repository, () => [{ branch, sha, url }], options);
      return url;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000);
  }
  return null;
}

function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      "dry-run": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: node scripts/upstream/landing-hold.ts [--dry-run]\nSets the Intake landing hold status on open pull requests and on landing intake candidates. --dry-run prints the decision without writing statuses.",
    );
    return;
  }
  const repository = process.env.GITHUB_REPOSITORY ?? process.env.GH_REPO ?? "incognitojam/styal";
  const runs = (workflow: string) =>
    (
      JSON.parse(
        gh(["api", `repos/${repository}/actions/workflows/${workflow}/runs?per_page=100`]),
      ) as { workflow_runs: Array<WorkflowRun> }
    ).workflow_runs;
  const holding = updateLandingHold(
    repository,
    () => holdingCandidates(runs("fork-ci.yml"), runs("promote-upstream-intake.yml"), Date.now()),
    { dryRun: values["dry-run"] === true },
  );
  // The workflow dispatches itself again then, since no event marks a grace period ending.
  const until = holding.flatMap((candidate) =>
    candidate.until === undefined ? [] : [candidate.until],
  );
  if (until.length > 0 && process.env.GITHUB_OUTPUT && !values["dry-run"]) {
    const seconds = Math.max(1, Math.ceil((Math.min(...until) - Date.now()) / 1000));
    NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, `recheck_in_seconds=${seconds}\n`);
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
