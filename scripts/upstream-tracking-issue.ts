#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - This tracking script calls gh from a short-lived Node process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { parseUpstreamProvenance } from "./upstream-provenance.ts";

/**
 * Reconciles recent upstream pull requests into the fork's rolling intake
 * issue. Every source reference it writes is inert, so the issue never
 * notifies upstream. Existing notes and explicit dispositions are preserved.
 */
export interface UpstreamPullRequest {
  readonly number: number;
  readonly title: string;
  readonly mergedAt: string;
  readonly areas: ReadonlyArray<string>;
}

const TRACKING_LINE_PATTERN = /^- \[([ x])\] `#(\d+)` (\d{4}-\d{2}-\d{2})\b/u;
const DISPOSITION_PATTERN = / — (promoted|already present|skip|review needed)\b/gu;
const CHERRY_PICK_REFERENCE = /\(cherry picked from commit ([0-9a-f]{40})\)/gu;
const TRACKING_BODY_TARGET_LENGTH = 55_000;
const OLD_INTRO = `Upstream pull requests not yet on \`main\`, newest last. Tick a box and add direction
beneath it, then dispatch an agent with the ticked items. The list is appended by
\`upstream-tracking.yml\`; edits here are preserved.
`;
const INTRO = `Upstream pull requests in the rolling one-week intake window, newest last. Tick an item
to retain and queue it, then add direction beneath it. Unticked items expire after the window. The
tracker marks landed source provenance as \`promoted\`. Manual dispositions are \`already present\`,
\`skip\`, and \`review needed\`; queued items and \`review needed\` decisions remain until resolved.
`;

export function listedNumbers(body: string): ReadonlySet<number> {
  const numbers = body.split("\n").flatMap((line) => {
    const match = line.match(TRACKING_LINE_PATTERN);
    return match === null ? [] : [Number(match[2])];
  });
  return new Set(numbers);
}

function inertInlineCode(value: string): string {
  return value.replaceAll("`", "'").replaceAll(/\s+/gu, " ").trim();
}

export function renderPullRequestLine(pullRequest: UpstreamPullRequest): string {
  const title = inertInlineCode(pullRequest.title);
  const areas =
    pullRequest.areas.length > 0
      ? ` · ${pullRequest.areas.map((area) => `\`${inertInlineCode(area)}\``).join(", ")}`
      : "";
  return `- [ ] \`#${pullRequest.number}\` ${pullRequest.mergedAt.slice(0, 10)} · \`${title}\`${areas}`;
}

export function appendUnlisted(
  body: string,
  candidates: ReadonlyArray<UpstreamPullRequest>,
): { readonly body: string; readonly added: ReadonlyArray<UpstreamPullRequest> } {
  const listed = listedNumbers(body);
  const added = candidates
    .filter((pullRequest) => !listed.has(pullRequest.number))
    .toSorted((left, right) => left.mergedAt.localeCompare(right.mergedAt));
  if (added.length === 0) return { body, added };

  const base = body.trim().length === 0 ? INTRO : body.trimEnd() + "\n";
  const lines = added.map(renderPullRequestLine).join("\n");
  return { body: `${base}\n${lines}\n`, added };
}

export function refreshTrackingIntro(body: string): string {
  return body.startsWith(OLD_INTRO) ? INTRO + body.slice(OLD_INTRO.length) : body;
}

function trackingDisposition(line: string): string | undefined {
  for (const match of line.matchAll(DISPOSITION_PATTERN)) {
    const backticksBefore = [...line.slice(0, match.index).matchAll(/`/gu)].length;
    if (backticksBefore % 2 === 0) return match[1];
  }
  return undefined;
}

export function reconcilePromoted(
  body: string,
  landed: ReadonlyMap<number, string>,
): { readonly body: string; readonly reconciled: ReadonlyArray<number> } {
  const reconciled: Array<number> = [];
  const lines = body.split("\n").map((line) => {
    const match = line.match(TRACKING_LINE_PATTERN);
    if (match === null || trackingDisposition(line) !== undefined) return line;
    const number = Number(match[2]);
    const forkSha = landed.get(number);
    if (forkSha === undefined) return line;
    reconciled.push(number);
    return `${line.replace(/^- \[[ x]\]/u, "- [x]")} — promoted \`${forkSha.slice(0, 7)}\``;
  });
  return { body: lines.join("\n"), reconciled };
}

export function pruneTrackingEntries(
  body: string,
  cutoffDate: string,
): {
  readonly body: string;
  readonly prunedTerminal: ReadonlyArray<number>;
  readonly expiredOpen: ReadonlyArray<number>;
  readonly retainedBacklog: ReadonlyArray<number>;
} {
  const lines = body.split("\n");
  const kept: Array<string> = [];
  const prunedTerminal: Array<number> = [];
  const expiredOpen: Array<number> = [];
  const retainedBacklog: Array<number> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = line.match(TRACKING_LINE_PATTERN);
    if (match === null || (match[3] ?? "") >= cutoffDate) {
      kept.push(line);
      continue;
    }

    const checked = match[1] === "x";
    const number = Number(match[2]);
    const disposition = trackingDisposition(line);
    const terminal =
      disposition === "promoted" || disposition === "already present" || disposition === "skip";
    if (!terminal && (checked || disposition === "review needed")) {
      retainedBacklog.push(number);
      kept.push(line);
      continue;
    }

    if (terminal) prunedTerminal.push(number);
    else expiredOpen.push(number);
    while (index + 1 < lines.length) {
      const next = lines[index + 1] ?? "";
      if (/^[\t ]/u.test(next)) {
        index += 1;
        continue;
      }
      if (next.length === 0 && /^[\t ]/u.test(lines[index + 2] ?? "")) {
        index += 1;
        continue;
      }
      break;
    }
  }

  return { body: kept.join("\n"), prunedTerminal, expiredOpen, retainedBacklog };
}

function removeTrackingEntry(lines: ReadonlyArray<string>, start: number): Array<string> {
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end] ?? "";
    if (/^[\t ]/u.test(line)) {
      end += 1;
      continue;
    }
    if (line.length === 0 && /^[\t ]/u.test(lines[end + 1] ?? "")) {
      end += 1;
      continue;
    }
    break;
  }
  return [...lines.slice(0, start), ...lines.slice(end)];
}

export function fitTrackingIssueBody(
  body: string,
  targetLength = TRACKING_BODY_TARGET_LENGTH,
): {
  readonly body: string;
  readonly compactedTerminal: ReadonlyArray<number>;
  readonly compactedOpen: ReadonlyArray<number>;
  readonly backlogCount: number;
  readonly overflow: boolean;
} {
  let lines = body.split("\n");
  const compactedTerminal: Array<number> = [];
  const compactedOpen: Array<number> = [];

  for (const removeTerminal of [true, false]) {
    let index = 0;
    while (lines.join("\n").length > targetLength && index < lines.length) {
      const line = lines[index] ?? "";
      const match = line.match(TRACKING_LINE_PATTERN);
      if (match === null) {
        index += 1;
        continue;
      }

      const checked = match[1] === "x";
      const number = Number(match[2]);
      const disposition = trackingDisposition(line);
      const terminal =
        disposition === "promoted" || disposition === "already present" || disposition === "skip";
      const open = !checked && disposition !== "review needed" && !terminal;
      if ((removeTerminal && terminal) || (!removeTerminal && open)) {
        if (terminal) compactedTerminal.push(number);
        else compactedOpen.push(number);
        lines = removeTrackingEntry(lines, index);
        continue;
      }
      index += 1;
    }
  }

  const fittedBody = lines.join("\n");
  const backlogCount = lines.filter((line) => {
    const match = line.match(TRACKING_LINE_PATTERN);
    if (match === null) return false;
    const disposition = trackingDisposition(line);
    const terminal =
      disposition === "promoted" || disposition === "already present" || disposition === "skip";
    return !terminal && (match[1] === "x" || disposition === "review needed");
  }).length;
  return {
    body: fittedBody,
    compactedTerminal,
    compactedOpen,
    backlogCount,
    overflow: fittedBody.length > targetLength,
  };
}

export interface GitCommitMessage {
  readonly sha: string;
  readonly message: string;
}

export function landedUpstreamPullRequests(
  commits: ReadonlyArray<GitCommitMessage>,
  upstreamMergeCommits: ReadonlyMap<string, number>,
): {
  readonly landed: ReadonlyMap<number, string>;
  readonly errors: ReadonlyArray<string>;
} {
  const landed = new Map<number, string>();
  const errors: Array<string> = [];

  for (const commit of commits) {
    const provenance = parseUpstreamProvenance([commit.message]);
    for (const error of provenance.errors) {
      errors.push(`${commit.sha.slice(0, 12)}: ${error}`);
    }
    for (const number of provenance.pullRequestNumbers) {
      if (!landed.has(number)) landed.set(number, commit.sha);
    }
    for (const match of commit.message.matchAll(CHERRY_PICK_REFERENCE)) {
      const number = upstreamMergeCommits.get(match[1] ?? "");
      if (number !== undefined && !landed.has(number)) landed.set(number, commit.sha);
    }
  }

  return { landed, errors };
}

export function areasForPaths(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(paths.map((path) => path.split("/").slice(0, 2).join("/")))].toSorted();
}

export function validateTrackingRepository(repository: string, upstream: string): void {
  if (repository.toLowerCase() === upstream.toLowerCase()) {
    throw new Error("The upstream tracking issue must belong to the fork, not upstream.");
  }
}

function run(command: string, args: ReadonlyArray<string>, input?: string): string {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8", input });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function gitCommitMessages(ref: string, sinceDays: number): ReadonlyArray<GitCommitMessage> {
  const output = run("git", ["log", `--since=${sinceDays}.days`, "--format=%H%x1f%B%x1e", ref]);
  return output
    .split("\x1e")
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const separator = record.indexOf("\x1f");
      if (separator === -1) throw new Error("Could not parse git history for upstream provenance.");
      return {
        sha: record.slice(0, separator),
        message: record.slice(separator + 1),
      };
    });
}

function isAncestorOf(sha: string, ref: string): boolean {
  const result = NodeChildProcess.spawnSync("git", ["merge-base", "--is-ancestor", sha, ref]);
  return result.status === 0;
}

interface GraphQlPullRequest {
  readonly number: number;
  readonly title: string;
  readonly mergedAt: string;
  readonly mergeCommit: { readonly oid: string } | null;
  readonly files: { readonly nodes: ReadonlyArray<{ readonly path: string }> };
}

function fetchMergedUpstreamPullRequests(
  repository: string,
  sinceIso: string,
): ReadonlyArray<GraphQlPullRequest & { readonly sha: string }> {
  const [owner, name] = repository.split("/");
  const query = `query($owner:String!,$name:String!,$cursor:String){
    repository(owner:$owner,name:$name){
      pullRequests(first:100,states:MERGED,orderBy:{field:UPDATED_AT,direction:DESC},after:$cursor){
        pageInfo{hasNextPage endCursor}
        nodes{number title mergedAt mergeCommit{oid} files(first:100){nodes{path}}}
      }
    }
  }`;
  const collected: Array<GraphQlPullRequest & { readonly sha: string }> = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
    ];
    if (cursor) args.push("-F", `cursor=${cursor}`);
    const response = JSON.parse(run("gh", args)) as {
      readonly data: {
        readonly repository: {
          readonly pullRequests: {
            readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
            readonly nodes: ReadonlyArray<GraphQlPullRequest>;
          };
        };
      };
    };
    const connection = response.data.repository.pullRequests;
    for (const node of connection.nodes) {
      if (node.mergedAt < sinceIso) continue;
      if (node.mergeCommit) collected.push({ ...node, sha: node.mergeCommit.oid });
    }
    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }
  return collected;
}

function main(): void {
  const args = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    args.set(process.argv[index]!, process.argv[index + 1] ?? "");
  }
  const issue = args.get("--issue");
  const repository = args.get("--repo");
  const upstream = args.get("--upstream") ?? "pingdotgg/t3code";
  const mainRef = args.get("--main-ref") ?? "origin/main";
  const upstreamRef = args.get("--upstream-ref") ?? "upstream/main";
  const sinceDays = Number(args.get("--since-days") ?? "7");
  if (!issue) throw new Error("--issue <number> is required.");
  // Never let gh infer the repository from git remotes: with upstream fetched,
  // it would resolve to upstream and try to edit their issue of the same number.
  if (!repository) throw new Error("--repo <owner/name> is required.");
  validateTrackingRepository(repository, upstream);
  if (!Number.isInteger(sinceDays) || sinceDays < 1) {
    throw new Error("--since-days must be a positive integer.");
  }

  const sinceIso = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const pruneBefore = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
  const merged = fetchMergedUpstreamPullRequests(upstream, sinceIso);
  const upstreamMergeCommits = new Map(
    merged.map((pullRequest) => [pullRequest.sha, pullRequest.number] as const),
  );
  const landedResult = landedUpstreamPullRequests(
    gitCommitMessages(mainRef, sinceDays),
    upstreamMergeCommits,
  );
  const candidates = merged
    .filter((pullRequest) => isAncestorOf(pullRequest.sha, upstreamRef))
    .filter((pullRequest) => !isAncestorOf(pullRequest.sha, mainRef))
    .map((pullRequest) => ({
      number: pullRequest.number,
      title: pullRequest.title,
      mergedAt: pullRequest.mergedAt,
      areas: areasForPaths(pullRequest.files.nodes.map((file) => file.path)),
    }));

  const currentBody = JSON.parse(
    run("gh", ["issue", "view", issue, "--repo", repository, "--json", "body"]),
  ) as {
    readonly body: string;
  };
  const appended = appendUnlisted(refreshTrackingIntro(currentBody.body), candidates);
  const reconciled = reconcilePromoted(appended.body, landedResult.landed);
  const pruned = pruneTrackingEntries(reconciled.body, pruneBefore);
  const fitted = fitTrackingIssueBody(pruned.body);
  if (fitted.overflow) {
    throw new Error(
      `The retained upstream backlog exceeds the ${TRACKING_BODY_TARGET_LENGTH}-character operating budget. Resolve or split backlog entries before rerunning the tracker.`,
    );
  }

  if (fitted.body !== currentBody.body) {
    const bodyPath = NodePath.join(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "upstream-tracking-")),
      "body.md",
    );
    NodeFS.writeFileSync(bodyPath, fitted.body);
    run("gh", ["issue", "edit", issue, "--repo", repository, "--body-file", bodyPath]);
  }

  console.log(`Appended ${appended.added.length} pull request(s).`);
  console.log(`Reconciled ${reconciled.reconciled.length} promoted pull request(s).`);
  console.log(`Pruned ${pruned.prunedTerminal.length} old terminal pull request(s).`);
  console.log(`Expired ${pruned.expiredOpen.length} old unqueued pull request(s).`);
  console.log(`Compacted ${fitted.compactedTerminal.length} recent terminal pull request(s).`);
  console.log(`Compacted ${fitted.compactedOpen.length} recent unqueued pull request(s).`);
  if (pruned.retainedBacklog.length > 0) {
    console.log(
      `Retained backlog entries outside the rolling window: ${pruned.retainedBacklog
        .map((number) => `\`#${number}\``)
        .join(", ")}`,
    );
  }
  const runSummary = `## Upstream tracking

- Issue body: ${fitted.body.length} / ${TRACKING_BODY_TARGET_LENGTH} operating characters
- Durable backlog: ${fitted.backlogCount} pull request(s)
- Appended: ${appended.added.length}
- Reconciled as promoted: ${reconciled.reconciled.length}
- Expired or compacted: ${pruned.expiredOpen.length + fitted.compactedOpen.length}
`;
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    NodeFS.appendFileSync(process.env.GITHUB_STEP_SUMMARY, runSummary);
  }
  if (fitted.body.length >= TRACKING_BODY_TARGET_LENGTH * 0.9) {
    console.log("::warning::The upstream tracking issue is above 90% of its operating budget.");
  }
  for (const error of landedResult.errors) console.log(`::warning::${error}`);
}

if (import.meta.main) main();
