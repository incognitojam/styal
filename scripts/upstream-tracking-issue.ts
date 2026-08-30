#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - This tracking script calls gh from a short-lived Node process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Appends upstream pull requests that are not yet on main to the tracking
 * issue. Every line it writes is inert: numbers and titles sit in backticks
 * and nothing links to upstream, so the issue never notifies upstream's
 * authors or shows up on their pull requests. Lines already in the issue,
 * including any checkbox or note a maintainer added, are left untouched.
 */
export interface UpstreamPullRequest {
  readonly number: number;
  readonly title: string;
  readonly mergedAt: string;
  readonly areas: ReadonlyArray<string>;
}

const TRACKED_NUMBER_PATTERN = /`#(\d+)`/g;
const INTRO = `Upstream pull requests not yet on \`main\`, newest last. Tick a box and add direction
beneath it, then dispatch an agent with the ticked items. The list is appended by
\`upstream-tracking.yml\`; edits here are preserved.
`;

export function listedNumbers(body: string): ReadonlySet<number> {
  return new Set([...body.matchAll(TRACKED_NUMBER_PATTERN)].map((match) => Number(match[1])));
}

export function renderPullRequestLine(pullRequest: UpstreamPullRequest): string {
  const title = pullRequest.title.replaceAll("`", "'").trim();
  const areas = pullRequest.areas.length > 0 ? ` · ${pullRequest.areas.join(", ")}` : "";
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

export function areasForPaths(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(paths.map((path) => path.split("/").slice(0, 2).join("/")))].toSorted();
}

function run(command: string, args: ReadonlyArray<string>, input?: string): string {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8", input });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
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
    let reachedCutoff = false;
    for (const node of connection.nodes) {
      if (node.mergedAt < sinceIso) {
        reachedCutoff = true;
        continue;
      }
      if (node.mergeCommit) collected.push({ ...node, sha: node.mergeCommit.oid });
    }
    if (reachedCutoff || !connection.pageInfo.hasNextPage) break;
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
  const upstream = args.get("--upstream") ?? "pingdotgg/t3code";
  const mainRef = args.get("--main-ref") ?? "origin/main";
  const upstreamRef = args.get("--upstream-ref") ?? "upstream/main";
  const sinceDays = Number(args.get("--since-days") ?? "45");
  if (!issue) throw new Error("--issue <number> is required.");

  const sinceIso = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const merged = fetchMergedUpstreamPullRequests(upstream, sinceIso);
  const candidates = merged
    .filter((pullRequest) => isAncestorOf(pullRequest.sha, upstreamRef))
    .filter((pullRequest) => !isAncestorOf(pullRequest.sha, mainRef))
    .map((pullRequest) => ({
      number: pullRequest.number,
      title: pullRequest.title,
      mergedAt: pullRequest.mergedAt,
      areas: areasForPaths(pullRequest.files.nodes.map((file) => file.path)),
    }));

  const currentBody = JSON.parse(run("gh", ["issue", "view", issue, "--json", "body"])) as {
    readonly body: string;
  };
  const { body, added } = appendUnlisted(currentBody.body, candidates);
  if (added.length === 0) {
    console.log("No unlisted upstream pull requests.");
    return;
  }

  const bodyPath = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "upstream-tracking-")),
    "body.md",
  );
  NodeFS.writeFileSync(bodyPath, body);
  run("gh", ["issue", "edit", issue, "--body-file", bodyPath]);
  console.log(
    `Appended ${added.length} pull request(s): ${added.map((p) => `#${p.number}`).join(", ")}`,
  );
}

if (import.meta.main) main();
