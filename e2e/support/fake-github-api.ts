// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - e2e harness runs plain Node outside any Effect runtime.
/**
 * A fake GitHub API for e2e tests. The server sends its GitHub requests here when started with
 * `T3CODE_TEST_GITHUB_API_URL` set to `url`. It answers the GraphQL issue list and issue reads
 * from `issues`, plus the pull request list, detail, policy and merge reads tests need, and
 * reports no pull requests for the branch lookups the server makes on its own. Any other
 * request gets an error answer and is printed, so a test that reaches one fails visibly instead
 * of talking to GitHub.
 */
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import type { FakeGitHubIssue } from "./environment.ts";

export interface FakeGitHubApiRequest {
  readonly method: string;
  readonly path: string;
  /** The GraphQL document, for a GraphQL request. */
  readonly query?: string;
  readonly variables?: Readonly<Record<string, unknown>>;
}

/** Mutable host state, so a test can push a commit after the client has read the detail. */
export interface FakeGitHubPullRequest {
  number: number;
  title: string;
  headSha: string;
  state?: "OPEN" | "MERGED";
  blocked?: boolean;
  requiredChecks?: ReadonlyArray<string>;
  checks?: ReadonlyArray<{ name: string; required: boolean }>;
}

export interface FakeGitHubApi {
  readonly url: string;
  readonly requests: () => ReadonlyArray<FakeGitHubApiRequest>;
  readonly stop: () => Promise<void>;
}

const RATE_LIMIT = { cost: 1, limit: 5000, remaining: 4999, resetAt: "2099-01-01T00:00:00Z" };

export async function startFakeGitHubApi(
  issues: ReadonlyArray<FakeGitHubIssue>,
  pullRequests: ReadonlyArray<FakeGitHubPullRequest> = [],
): Promise<FakeGitHubApi> {
  const requests: FakeGitHubApiRequest[] = [];
  const pageInfo = { hasNextPage: false, endCursor: null };
  const connection = (nodes: ReadonlyArray<unknown>) => ({ nodes, pageInfo });
  const repository = (fields: Record<string, unknown>) => ({
    data: { repository: fields },
    rateLimit: RATE_LIMIT,
  });
  const detail = (pr: FakeGitHubPullRequest) => ({
    id: `PR_${pr.number}`,
    number: pr.number,
    title: pr.title,
    url: `https://github.com/e2e-org/demo-app/pull/${pr.number}`,
    body: "A synthetic pull request for end-to-end tests.",
    state: pr.state ?? "OPEN",
    isDraft: false,
    author: { login: "e2e-user" },
    repository: { nameWithOwner: "e2e-org/demo-app" },
    headRefName: `change-${pr.number}`,
    baseRefName: "main",
    headRefOid: pr.headSha,
    isCrossRepository: false,
    headRepositoryOwner: { login: "e2e-org" },
    mergeable: "MERGEABLE",
    mergeStateStatus: pr.blocked ? "BLOCKED" : "CLEAN",
    isMergeQueueEnabled: false,
    autoMergeRequest: null,
    additions: 4,
    deletions: 1,
    changedFiles: 1,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    viewerCanUpdate: true,
    viewerDidAuthor: true,
    viewerCanUpdateBranch: true,
    viewerCanEnableAutoMerge: true,
    viewerCanDisableAutoMerge: true,
    baseRef: { compare: { behindBy: 0 } },
    reviewRequests: connection([]),
    labels: connection([]),
    commits: connection([
      {
        commit: {
          statusCheckRollup: {
            state: "SUCCESS",
            contexts: connection(
              (pr.checks ?? []).map((check) => ({
                __typename: "CheckRun",
                name: check.name,
                isRequired: check.required,
                status: "COMPLETED",
                conclusion: "SUCCESS",
                detailsUrl: `https://github.com/e2e-org/demo-app/actions/runs/${pr.number}`,
              })),
            ),
          },
        },
      },
    ]),
  });

  const answerGraphQl = (request: FakeGitHubApiRequest): unknown => {
    const query = request.query ?? "";
    const pr = pullRequests.find((item) => item.number === request.variables?.number);
    if (pullRequests.length > 0) {
      if (query.includes("search(query:")) {
        const q = String(request.variables?.q ?? "");
        const number = /"#?(\d+)"/.exec(q)?.[1] ?? /\/pull\/(\d+)/.exec(q)?.[1];
        return {
          data: {
            search: connection(
              pullRequests
                .filter((item) => number === undefined || item.number === Number(number))
                .map(detail),
            ),
          },
          rateLimit: RATE_LIMIT,
        };
      }
      if (/^query PullRequest(Stats|Summaries)\(/.test(query)) {
        return {
          data: Object.fromEntries(
            Object.keys(request.variables ?? {})
              .filter((key) => /^s\d+_number$/.test(key))
              .map((key) => {
                const item = pullRequests.find(
                  (candidate) => candidate.number === request.variables?.[key],
                );
                return [key.split("_")[0], { pullRequest: item ? detail(item) : null }];
              }),
          ),
          rateLimit: RATE_LIMIT,
        };
      }
      if (query.includes("branchProtectionRule")) {
        const required = [...new Set(pullRequests.flatMap((item) => item.requiredChecks ?? []))];
        return repository({
          ref: {
            branchProtectionRule: {
              requiredStatusCheckContexts: required,
              requiresStrictStatusChecks: false,
            },
          },
        });
      }
      if (query.includes("checkSuites(first:")) {
        return repository({ object: { checkSuites: connection([]) } });
      }
      if (query.includes("mergePullRequest(input:")) {
        const input = request.variables?.input as {
          pullRequestId: string;
          expectedHeadOid?: string;
        };
        const merging = pullRequests.find((item) => `PR_${item.number}` === input.pullRequestId);
        if (!merging) return undefined;
        if (input.expectedHeadOid !== merging.headSha) {
          return { errors: [{ message: "Head branch was modified" }] };
        }
        merging.state = "MERGED";
        return { data: { mergePullRequest: { clientMutationId: null } } };
      }
      if (pr) {
        if (query.includes("viewerMergeBodyText")) {
          return repository({
            pullRequest: { ...detail(pr), viewerMergeBodyText: "Merge change" },
          });
        }
        if (query.includes("$withComments:")) {
          return repository({
            pullRequest: {
              author: { login: "e2e-user" },
              comments: connection([]),
              reviews: connection([]),
              commits: connection([]),
            },
          });
        }
        if (query.includes("reviewThreads(first:")) {
          return repository({ pullRequest: { reviewThreads: connection([]) } });
        }
        if (query.includes("pullRequest(number:")) {
          return repository({
            mergeCommitAllowed: true,
            squashMergeAllowed: true,
            rebaseMergeAllowed: true,
            viewerPermission: "WRITE",
            pullRequest: detail(pr),
          });
        }
      }
    }
    if (query.includes("issues(first:")) {
      return {
        data: {
          repository: {
            issues: {
              nodes: issues.map((issue) => ({
                number: issue.number,
                title: issue.title,
                url: issue.url,
                state: issue.state,
                updatedAt: "2026-10-01T00:00:00Z",
                labels: { nodes: [] },
              })),
            },
          },
          rateLimit: RATE_LIMIT,
        },
      };
    }
    if (query.startsWith("query PullRequestsByHead(")) {
      // No pull requests: every aliased head lookup (`h0`, `h1`, ...) comes back empty.
      const aliases = Object.keys(request.variables ?? {}).filter((name) => /^h\d+$/.test(name));
      return {
        data: {
          repository: Object.fromEntries(aliases.map((alias) => [alias, { nodes: [] }])),
          rateLimit: RATE_LIMIT,
        },
      };
    }
    if (query.includes("issue(number:")) {
      const issue = issues.find((candidate) => candidate.number === request.variables?.number);
      return {
        data: {
          repository: {
            issue:
              issue === undefined
                ? null
                : {
                    number: issue.number,
                    title: issue.title,
                    url: issue.url,
                    state: issue.state,
                    body: issue.body,
                    author: issue.author,
                    comments: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: issue.comments,
                    },
                  },
          },
          rateLimit: RATE_LIMIT,
        },
      };
    }
    return undefined;
  };

  const server = NodeHttp.createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const method = incoming.method ?? "GET";
      const path = incoming.url ?? "/";
      let request: FakeGitHubApiRequest = { method, path };
      if (method === "POST" && path === "/graphql") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          readonly query: string;
          readonly variables?: Record<string, unknown>;
        };
        request = { ...request, query: body.query, variables: body.variables ?? {} };
      }
      requests.push(request);
      const answer =
        request.query !== undefined
          ? answerGraphQl(request)
          : pullRequests.length === 0
            ? undefined
            : path === "/user"
              ? { id: 1, login: "e2e-user" }
              : path.startsWith("/repos/e2e-org/demo-app/rules/branches/") ||
                  path.startsWith("/repos/e2e-org/demo-app/stacks?")
                ? []
                : undefined;
      if (answer === undefined) {
        const message = `fake GitHub API: unsupported request ${method} ${path}${
          request.query === undefined ? "" : `\n${request.query}`
        }`;
        process.stderr.write(`${message}\n`);
        response.writeHead(501, { "content-type": "application/json" });
        response.end(JSON.stringify({ message, errors: [{ message }] }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(answer));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as NodeNet.AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => requests,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
