#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - This tracking script calls gh from a short-lived Node process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

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
const TERMINAL_STATE_PATTERN = /^<!-- upstream-tracking-terminal:(.*?)-->$/gmu;
const CATCHUP_SINCE_PATTERN = /^<!-- upstream-tracking-catchup-since:(.*?)-->$/gmu;
const TRACKING_STATE_LINE_PATTERN = /^<!-- upstream-tracking-(?:terminal|catchup-since):.*-->$/u;
const TRACKING_BODY_TARGET_LENGTH = 55_000;
const MAX_UPSTREAM_PAGES = 20;
const OLD_INTRO = `Upstream pull requests not yet on \`main\`, newest last. Tick a box and add direction
beneath it, then dispatch an agent with the ticked items. The list is appended by
\`upstream-tracking.yml\`; edits here are preserved.
`;
const INTRO = `Upstream pull requests in the rolling intake window, oldest first. Tick an item
to retain and queue it, then add direction beneath it. Unticked items expire after the window. The
tracker marks landed source provenance as \`promoted\`. Manual dispositions are \`already present\`,
\`skip\`, and \`review needed\`; append them as \`— skip: reason\` (or the corresponding state).
Queued items and \`review needed\` decisions remain until resolved.
`;

export function listedNumbers(body: string): ReadonlySet<number> {
  const numbers = body.split("\n").flatMap((line) => {
    const match = line.match(TRACKING_LINE_PATTERN);
    return match === null ? [] : [Number(match[2])];
  });
  return new Set(numbers);
}

export function terminalStateNumbers(body: string): ReadonlySet<number> {
  const matches = [...body.matchAll(TERMINAL_STATE_PATTERN)];
  if (matches.length > 1) throw new Error("The tracking issue contains multiple terminal markers.");
  const value = matches[0]?.[1]?.trim();
  if (value === undefined || value.length === 0) return new Set();
  if (!/^[1-9]\d*(?:,[1-9]\d*)*$/u.test(value)) {
    throw new Error("The tracking issue terminal marker is malformed.");
  }
  const numbers = value.split(",").map(Number);
  if (!numbers.every(Number.isSafeInteger)) {
    throw new Error("The tracking issue terminal marker contains an invalid pull request number.");
  }
  return new Set(numbers);
}

export function catchupSinceIso(body: string): string | undefined {
  const matches = [...body.matchAll(CATCHUP_SINCE_PATTERN)];
  if (matches.length > 1) throw new Error("The tracking issue contains multiple catch-up markers.");
  const value = matches[0]?.[1]?.trim();
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error("The tracking issue catch-up marker is malformed.");
  }
  return value;
}

function withoutTrackingState(body: string): string {
  const output: Array<string> = [];
  let removedState = false;
  for (const line of body.split("\n")) {
    if (TRACKING_STATE_LINE_PATTERN.test(line)) {
      while (output.at(-1)?.trim().length === 0) output.pop();
      removedState = true;
      continue;
    }
    if (removedState && line.trim().length === 0) continue;
    if (removedState && output.length > 0) output.push("");
    removedState = false;
    output.push(line);
  }
  return output.join("\n").trimEnd();
}

export function writeTrackingState(
  body: string,
  state: {
    readonly terminal: ReadonlySet<number>;
    readonly catchupSince?: string;
  },
): string {
  const content = withoutTrackingState(body);
  const markers: Array<string> = [];
  if (state.terminal.size > 0) {
    const value = [...state.terminal].toSorted((left, right) => left - right).join(",");
    markers.push(`<!-- upstream-tracking-terminal:${value} -->`);
  }
  if (state.catchupSince !== undefined) {
    markers.push(`<!-- upstream-tracking-catchup-since:${state.catchupSince} -->`);
  }
  if (markers.length === 0) return `${content}\n`;
  return `${content}\n\n${markers.join("\n")}\n`;
}

export function writeTerminalState(body: string, numbers: ReadonlySet<number>): string {
  const catchupSince = catchupSinceIso(body);
  return writeTrackingState(body, {
    terminal: numbers,
    ...(catchupSince === undefined ? {} : { catchupSince }),
  });
}

export function writeCatchupSince(body: string, sinceIso?: string): string {
  return writeTrackingState(body, {
    terminal: terminalStateNumbers(body),
    ...(sinceIso === undefined ? {} : { catchupSince: sinceIso }),
  });
}

export function effectiveScanBoundary(body: string, configuredSinceIso: string): string {
  const saved = catchupSinceIso(body);
  return saved !== undefined && saved < configuredSinceIso ? saved : configuredSinceIso;
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

  const base = body.trim().length === 0 ? `${INTRO}\n` : body;
  const lines = base.trimEnd().split("\n");
  for (const pullRequest of added) {
    const date = pullRequest.mergedAt.slice(0, 10);
    const laterEntry = lines.findIndex((line) => {
      const match = line.match(TRACKING_LINE_PATTERN);
      return match !== null && (match[3] ?? "") > date;
    });
    const stateMarker = lines.findIndex((line) => line.startsWith("<!-- upstream-tracking-"));
    const insertion =
      laterEntry === -1 ? (stateMarker === -1 ? lines.length : stateMarker) : laterEntry;
    lines.splice(insertion, 0, renderPullRequestLine(pullRequest));
  }
  return { body: `${lines.join("\n")}\n`, added };
}

export function refreshTrackingIntro(body: string): string {
  return body.startsWith(OLD_INTRO) ? INTRO + body.slice(OLD_INTRO.length) : body;
}

function trackingDispositionMatch(
  line: string,
): { readonly kind: string; readonly index: number } | undefined {
  for (const match of line.matchAll(DISPOSITION_PATTERN)) {
    const backticksBefore = [...line.slice(0, match.index).matchAll(/`/gu)].length;
    if (backticksBefore % 2 === 0) return { kind: match[1] ?? "", index: match.index };
  }
  return undefined;
}

function trackingDisposition(line: string): string | undefined {
  return trackingDispositionMatch(line)?.kind;
}

export function reconcilePromoted(
  body: string,
  landed: ReadonlyMap<number, string>,
): { readonly body: string; readonly reconciled: ReadonlyArray<number> } {
  const reconciled: Array<number> = [];
  const lines = body.split("\n").map((line) => {
    const match = line.match(TRACKING_LINE_PATTERN);
    if (match === null) return line;
    const disposition = trackingDispositionMatch(line);
    if (
      disposition !== undefined &&
      (disposition.kind === "promoted" ||
        disposition.kind === "already present" ||
        disposition.kind === "skip")
    ) {
      return line;
    }
    const number = Number(match[2]);
    const forkSha = landed.get(number);
    if (forkSha === undefined) return line;
    reconciled.push(number);
    const withoutReview =
      disposition?.kind === "review needed" ? line.slice(0, disposition.index) : line;
    return `${withoutReview.replace(/^- \[[ x]\]/u, "- [x]")} — promoted \`${forkSha.slice(0, 7)}\``;
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
  readonly deferredOpen: ReadonlyArray<number>;
  readonly backlogCount: number;
  readonly overflow: boolean;
} {
  let lines = body.split("\n");
  const compactedTerminal: Array<number> = [];
  const deferredOpen: Array<number> = [];

  for (const removeTerminal of [true, false]) {
    let index = removeTerminal ? 0 : lines.length - 1;
    while (lines.join("\n").length > targetLength && index >= 0 && index < lines.length) {
      const line = lines[index] ?? "";
      const match = line.match(TRACKING_LINE_PATTERN);
      if (match === null) {
        index += removeTerminal ? 1 : -1;
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
        else deferredOpen.push(number);
        lines = removeTrackingEntry(lines, index);
        if (!removeTerminal) index = Math.min(index - 1, lines.length - 1);
        continue;
      }
      index += removeTerminal ? 1 : -1;
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
    deferredOpen,
    backlogCount,
    overflow: fittedBody.length > targetLength,
  };
}

export function prepareTrackingIssueUpdate(input: {
  readonly body: string;
  readonly candidates: ReadonlyArray<UpstreamPullRequest>;
  readonly landed: ReadonlyMap<number, string>;
  readonly cutoffDate: string;
  readonly targetLength?: number;
}) {
  const previousTerminal = terminalStateNumbers(input.body);
  const candidateNumbers = new Set(input.candidates.map((pullRequest) => pullRequest.number));
  const activeTerminal = new Set(
    [...previousTerminal].filter((number) => candidateNumbers.has(number)),
  );
  const appended = appendUnlisted(
    refreshTrackingIntro(input.body),
    input.candidates.filter((pullRequest) => !activeTerminal.has(pullRequest.number)),
  );
  const reconciled = reconcilePromoted(appended.body, input.landed);
  const pruned = pruneTrackingEntries(reconciled.body, input.cutoffDate);
  for (const number of pruned.prunedTerminal) {
    if (candidateNumbers.has(number)) activeTerminal.add(number);
  }

  const compactedTerminal: Array<number> = [];
  const deferredOpen: Array<number> = [];
  let bodyWithState = writeTerminalState(pruned.body, activeTerminal);
  let fitted: ReturnType<typeof fitTrackingIssueBody>;
  while (true) {
    const pass = fitTrackingIssueBody(bodyWithState, input.targetLength);
    compactedTerminal.push(...pass.compactedTerminal);
    deferredOpen.push(...pass.deferredOpen);
    for (const number of pass.compactedTerminal) {
      if (candidateNumbers.has(number)) activeTerminal.add(number);
    }
    if (pass.compactedTerminal.length === 0) {
      fitted = {
        ...pass,
        compactedTerminal,
        deferredOpen,
      };
      break;
    }
    bodyWithState = writeTerminalState(pass.body, activeTerminal);
  }

  return { body: fitted.body, appended, reconciled, pruned, fitted };
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
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    input,
    maxBuffer: 16 * 1_024 * 1_024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function gitCommitMessages(ref: string): ReadonlyArray<GitCommitMessage> {
  const output = run("git", [
    "log",
    "--regexp-ignore-case",
    "--grep=Upstream-PR:",
    "--grep=Source PRs:",
    "--grep=cherry picked from commit",
    "--format=%H%x1f%B%x1e",
    ref,
  ]);
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
  readonly updatedAt: string;
  readonly mergeCommit: { readonly oid: string } | null;
  readonly files: { readonly nodes: ReadonlyArray<{ readonly path: string }> };
}

export function upstreamPageReachesWindowBoundary(
  pullRequests: ReadonlyArray<Pick<GraphQlPullRequest, "updatedAt">>,
  sinceIso: string,
): boolean {
  const oldestUpdated = pullRequests.at(-1)?.updatedAt;
  return oldestUpdated === undefined || oldestUpdated < sinceIso;
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
        nodes{number title mergedAt updatedAt mergeCommit{oid} files(first:100){nodes{path}}}
      }
    }
  }`;
  const collected: Array<GraphQlPullRequest & { readonly sha: string }> = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_UPSTREAM_PAGES; page += 1) {
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
    if (
      !connection.pageInfo.hasNextPage ||
      upstreamPageReachesWindowBoundary(connection.nodes, sinceIso)
    ) {
      break;
    }
    if (page === MAX_UPSTREAM_PAGES - 1) {
      console.log(
        `::warning::Upstream pull request scan reached the ${MAX_UPSTREAM_PAGES}-page safety cap before the configured window boundary.`,
      );
      break;
    }
    if (connection.pageInfo.endCursor === null) {
      throw new Error("Upstream pagination has another page but did not return a cursor.");
    }
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
  const sinceDays = Number(args.get("--since-days") ?? "14");
  if (!issue) throw new Error("--issue <number> is required.");
  // Never let gh infer the repository from git remotes: with upstream fetched,
  // it would resolve to upstream and try to edit their issue of the same number.
  if (!repository) throw new Error("--repo <owner/name> is required.");
  validateTrackingRepository(repository, upstream);
  if (!Number.isInteger(sinceDays) || sinceDays < 1) {
    throw new Error("--since-days must be a positive integer.");
  }

  const currentIssue = JSON.parse(
    run("gh", ["issue", "view", issue, "--repo", repository, "--json", "body"]),
  ) as {
    readonly body: string;
  };
  const configuredSinceIso = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const sinceIso = effectiveScanBoundary(currentIssue.body, configuredSinceIso);
  const pruneBefore = sinceIso.slice(0, 10);
  const merged = fetchMergedUpstreamPullRequests(upstream, sinceIso);
  const upstreamMergeCommits = new Map(
    merged.map((pullRequest) => [pullRequest.sha, pullRequest.number] as const),
  );
  const landedResult = landedUpstreamPullRequests(gitCommitMessages(mainRef), upstreamMergeCommits);
  const candidates = merged
    .filter((pullRequest) => isAncestorOf(pullRequest.sha, upstreamRef))
    .filter((pullRequest) => !isAncestorOf(pullRequest.sha, mainRef))
    .map((pullRequest) => ({
      number: pullRequest.number,
      title: pullRequest.title,
      mergedAt: pullRequest.mergedAt,
      areas: areasForPaths(pullRequest.files.nodes.map((file) => file.path)),
    }));

  const update = prepareTrackingIssueUpdate({
    body: writeCatchupSince(currentIssue.body, sinceIso),
    candidates,
    landed: landedResult.landed,
    cutoffDate: pruneBefore,
  });
  const { appended, reconciled, pruned, fitted } = update;
  if (fitted.overflow) {
    throw new Error(
      `The retained upstream backlog exceeds the ${TRACKING_BODY_TARGET_LENGTH}-character operating budget. Resolve or split backlog entries before rerunning the tracker.`,
    );
  }

  const nextBody = fitted.deferredOpen.length === 0 ? writeCatchupSince(update.body) : update.body;
  if (nextBody !== currentIssue.body) {
    run("gh", ["issue", "edit", issue, "--repo", repository, "--body-file", "-"], nextBody);
  }

  console.log(`Appended ${appended.added.length} pull request(s).`);
  console.log(`Reconciled ${reconciled.reconciled.length} promoted pull request(s).`);
  console.log(`Pruned ${pruned.prunedTerminal.length} old terminal pull request(s).`);
  console.log(`Expired ${pruned.expiredOpen.length} old unqueued pull request(s).`);
  console.log(`Compacted ${fitted.compactedTerminal.length} terminal pull request(s).`);
  console.log(`Deferred ${fitted.deferredOpen.length} newer unqueued pull request(s).`);
  if (pruned.retainedBacklog.length > 0) {
    console.log(
      `Retained backlog entries outside the rolling window: ${pruned.retainedBacklog
        .map((number) => `\`#${number}\``)
        .join(", ")}`,
    );
  }
  const runSummary = `## Upstream tracking

- Issue body: ${nextBody.length} / ${TRACKING_BODY_TARGET_LENGTH} operating characters
- Scan boundary: ${sinceIso}
- Durable backlog: ${fitted.backlogCount} pull request(s)
- Deferred catch-up candidates: ${fitted.deferredOpen.length}
- Appended: ${appended.added.length}
- Reconciled as promoted: ${reconciled.reconciled.length}
- Expired: ${pruned.expiredOpen.length}
`;
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    NodeFS.appendFileSync(process.env.GITHUB_STEP_SUMMARY, runSummary);
  }
  if (nextBody.length >= TRACKING_BODY_TARGET_LENGTH * 0.9) {
    console.log("::warning::The upstream tracking issue is above 90% of its operating budget.");
  }
  for (const error of landedResult.errors) console.log(`::warning::${error}`);
}

if (import.meta.main) main();
