// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - e2e harness runs plain Node outside any Effect runtime.
/**
 * The server sends its GitHub requests here when started with `T3CODE_TEST_GITHUB_API_URL` set
 * to `url`. Unhandled requests get an error answer and are printed, so a test that reaches one
 * fails visibly instead of talking to GitHub.
 */
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import type { FakeGitHubIssue } from "./environment.ts";

export interface FakeGitHubApiRequest {
  readonly method: string;
  readonly path: string;
  /** The GraphQL document, for a GraphQL request. */
  readonly query?: string;
  readonly operationName?: string;
  readonly variables?: Readonly<Record<string, unknown>>;
  /** The JSON body of a REST mutation. */
  readonly body?: Readonly<Record<string, unknown>>;
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

/** Mutable Actions state, including deployments the viewer may or may not review. */
export interface FakeGitHubWorkflowRun {
  id: number;
  name: string;
  status: "waiting" | "in_progress" | "completed";
  conclusion?: "success" | "failure";
  environments: ReadonlyArray<{ id: number; name: string; canApprove?: boolean }>;
  failedJobs?: ReadonlyArray<{ name: string; conclusion: string }>;
  reviewError?: { status: number; message: string };
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
  workflowRuns: ReadonlyArray<FakeGitHubWorkflowRun> = [],
): Promise<FakeGitHubApi> {
  const requests: FakeGitHubApiRequest[] = [];
  const pageInfo = { hasNextPage: false, endCursor: null };
  const connection = (nodes: ReadonlyArray<unknown>) => ({ nodes, pageInfo });
  const repository = (fields: Record<string, unknown>) => ({ repository: fields });
  const detail = (pr: FakeGitHubPullRequest) => ({
    __typename: "PullRequest",
    id: `PR_${pr.number}`,
    number: pr.number,
    title: pr.title,
    url: `https://github.com/e2e-org/demo-app/pull/${pr.number}`,
    body: "A synthetic pull request for end-to-end tests.",
    state: pr.state ?? "OPEN",
    isDraft: false,
    author: {
      __typename: "User",
      id: "USER_e2e",
      login: "e2e-user",
      name: "E2E User",
      // Inline, so the browser loads it without leaving the test origins.
      avatarUrl:
        "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E",
    },
    repository: { nameWithOwner: "e2e-org/demo-app" },
    headRefName: `change-${pr.number}`,
    baseRefName: "main",
    headRefOid: pr.headSha,
    isCrossRepository: false,
    headRepositoryOwner: { __typename: "Organization", login: "e2e-org" },
    headRepository: { nameWithOwner: "e2e-org/demo-app", viewerPermission: "WRITE" },
    headRef: { id: `REF_${pr.number}` },
    mergeable: "MERGEABLE",
    mergeStateStatus: pr.blocked ? "BLOCKED" : "CLEAN",
    isMergeQueueEnabled: false,
    autoMergeRequest: null,
    isInMergeQueue: false,
    reviewDecision: null,
    mergedAt: pr.state === "MERGED" ? "2026-10-01T00:00:00Z" : null,
    closedAt: pr.state === "MERGED" ? "2026-10-01T00:00:00Z" : null,
    stack: null,
    stackEntry: null,
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
    latestReviews: connection([]),
    timelineItems: { nodes: [], pageInfo: { hasPreviousPage: false } },
    commits: connection([
      {
        commit: {
          deployments: connection([]),
          statusCheckRollup: {
            state: "SUCCESS",
            contexts: connection(
              (pr.checks ?? []).map((check) => ({
                __typename: "CheckRun",
                name: check.name,
                isRequired: check.required,
                status: "COMPLETED",
                conclusion: "SUCCESS",
                startedAt: null,
                completedAt: null,
                checkSuite: { workflowRun: null },
                detailsUrl: `https://github.com/e2e-org/demo-app/actions/runs/${pr.number}`,
              })),
            ),
          },
        },
      },
    ]),
  });

  // Each case answers the fields selected by the corresponding generated operation.
  const answerOperation = (
    operationName: string | undefined,
    variables: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> | undefined => {
    const pr = pullRequests.find((item) => item.number === variables.number);
    switch (operationName) {
      case "PullRequestsByHead":
        // The synthetic workspace's branch has no linked pull request.
        return repository({ pullRequests: connection([]) });
      case "GitHubIssues":
        return repository({
          issues: connection(
            issues.map((issue) => ({
              number: issue.number,
              title: issue.title,
              url: issue.url,
              state: issue.state,
              updatedAt: "2026-10-01T00:00:00Z",
              labels: connection([]),
            })),
          ),
        });
      case "GitHubIssue": {
        const issue = issues.find((item) => item.number === variables.number);
        return repository({
          issue: issue
            ? {
                ...issue,
                author: { __typename: "User", ...issue.author },
                comments: connection(
                  issue.comments.map((comment) => ({
                    ...comment,
                    author: { __typename: "User", ...comment.author },
                  })),
                ),
              }
            : null,
        });
      }
      case "PullRequestSearch": {
        const q = String(variables.q ?? "");
        const number = /"#?(\d+)"/.exec(q)?.[1] ?? /\/pull\/(\d+)/.exec(q)?.[1];
        return {
          search: connection(
            pullRequests
              .filter((item) => number === undefined || item.number === Number(number))
              .map(detail),
          ),
        };
      }
      case "PullRequestList":
        return repository({ pullRequests: connection(pullRequests.map(detail)) });
      case "PullRequestSummary":
      case "PullRequestActionState":
      case "PullRequestCheckContexts":
      case "AutoMergePermissions":
        return repository({ pullRequest: pr ? detail(pr) : null });
      case "PullRequestCore":
      case "ViewerPermissions":
        return repository({
          mergeCommitAllowed: true,
          squashMergeAllowed: true,
          rebaseMergeAllowed: true,
          autoMergeAllowed: true,
          viewerPermission: "WRITE",
          pullRequest: pr ? detail(pr) : null,
        });
      case "BranchProtectionRequiredChecks":
        return repository({
          ref: {
            branchProtectionRule: {
              requiredStatusCheckContexts: [
                ...new Set(pullRequests.flatMap((item) => item.requiredChecks ?? [])),
              ],
              requiresStrictStatusChecks: false,
            },
          },
        });
      case "PullRequestFileStats":
        // Matches the additions, deletions, and file count `detail` reports.
        return repository({
          pullRequest: pr
            ? { files: connection([{ path: "src/app.ts", additions: 4, deletions: 1 }]) }
            : null,
        });
      case "WorkflowApprovalSuites":
        return repository({ object: { __typename: "Commit", checkSuites: connection([]) } });
      case "PullRequestActivity":
        return repository({
          pullRequest: pr
            ? {
                author: detail(pr).author,
                comments: connection([]),
                reviews: connection([]),
                commits: connection([]),
              }
            : null,
        });
      case "ReviewThreads":
        return {
          viewer: { login: "e2e-user" },
          ...repository({
            pullRequest: pr
              ? {
                  ...detail(pr),
                  reviewThreads: { ...connection([]), totalCount: 0 },
                  reactionGroups: [],
                  comments: connection([]),
                  reviews: connection([]),
                  reviewDismissals: connection([]),
                  commits: connection([]),
                }
              : null,
          }),
        };
      case "MergePullRequest": {
        const input = variables.input as { pullRequestId: string; expectedHeadOid?: string };
        const merging = pullRequests.find((item) => `PR_${item.number}` === input.pullRequestId);
        if (!merging) return undefined;
        merging.state = "MERGED";
        return { mergePullRequest: { clientMutationId: null } };
      }
      default:
        return undefined;
    }
  };

  const answerGraphQl = (request: FakeGitHubApiRequest): unknown => {
    const variables = request.variables ?? {};
    if (request.operationName === "MergePullRequest") {
      const input = variables.input as { pullRequestId: string; expectedHeadOid?: string };
      const merging = pullRequests.find((item) => `PR_${item.number}` === input.pullRequestId);
      if (merging && input.expectedHeadOid !== merging.headSha) {
        return { errors: [{ message: "Head branch was modified" }] };
      }
    }
    // effect/graphql repeats a generated operation's root selections and variables under
    // `_0_`, `_1_`, ... prefixes. Answer each lookup independently and preserve its aliases.
    const prefixes = [
      ...new Set(Object.keys(variables).flatMap((key) => /^_\d+_/.exec(key) ?? [])),
    ];
    const data: Record<string, unknown> = {};
    for (const prefix of prefixes.length === 0 ? [""] : prefixes) {
      const lookup = Object.fromEntries(
        Object.entries(variables)
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => [key.slice(prefix.length), value]),
      );
      const answer = answerOperation(request.operationName, lookup);
      if (answer === undefined) return undefined;
      for (const [key, value] of Object.entries(answer)) data[`${prefix}${key}`] = value;
    }
    return { data, rateLimit: RATE_LIMIT };
  };

  const answerWorkflowRun = (request: FakeGitHubApiRequest) => {
    const match = /^\/repos\/e2e-org\/demo-app\/actions\/runs\/(\d+)(.*)$/.exec(request.path);
    const run = workflowRuns.find((item) => item.id === Number(match?.[1]));
    if (!run) return undefined;
    const url = `https://github.com/e2e-org/demo-app/actions/runs/${run.id}`;
    if (request.method === "GET" && match?.[2] === "") {
      return {
        status: 200,
        body: {
          name: run.name,
          run_number: run.id,
          status: run.status,
          conclusion: run.conclusion ?? null,
          html_url: url,
          head_branch: "main",
          head_sha: "d".repeat(40),
          event: "workflow_dispatch",
        },
      };
    }
    if (request.method === "GET" && match?.[2]?.startsWith("/jobs?")) {
      return {
        status: 200,
        body: {
          jobs: (run.failedJobs ?? []).map((job) => ({
            ...job,
            html_url: `${url}/job/1`,
          })),
        },
      };
    }
    if (match?.[2] !== "/pending_deployments") return undefined;
    if (request.method === "GET") {
      return {
        status: 200,
        body: run.environments.map(({ canApprove, ...environment }) => ({
          environment,
          current_user_can_approve: canApprove ?? true,
        })),
      };
    }
    if (request.method !== "POST") return undefined;
    if (run.reviewError) {
      return { status: run.reviewError.status, body: { message: run.reviewError.message } };
    }
    const ids = request.body?.environment_ids;
    const state = request.body?.state;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      !ids.every((id) =>
        run.environments.some((item) => item.id === id && item.canApprove !== false),
      ) ||
      (state !== "approved" && state !== "rejected")
    ) {
      return { status: 422, body: { message: "Invalid deployment review" } };
    }
    run.environments =
      state === "rejected" ? [] : run.environments.filter((item) => !ids.includes(item.id));
    if (state === "rejected") {
      run.status = "completed";
      run.conclusion = "failure";
    } else if (run.environments.length === 0) {
      run.status = "in_progress";
    }
    return { status: 200, body: [] };
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
          readonly operationName?: string;
          readonly variables?: Record<string, unknown>;
        };
        request = {
          ...request,
          query: body.query,
          ...(body.operationName === undefined ? {} : { operationName: body.operationName }),
          variables: body.variables ?? {},
        };
      } else if (chunks.length > 0) {
        request = { ...request, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
      }
      requests.push(request);
      const workflow = answerWorkflowRun(request);
      const answer =
        request.query !== undefined
          ? answerGraphQl(request)
          : workflow !== undefined
            ? workflow.body
            : pullRequests.length === 0 && workflowRuns.length === 0
              ? undefined
              : path === "/user"
                ? { id: 1, login: "e2e-user" }
                : path.startsWith("/repos/e2e-org/demo-app/rules/branches/") ||
                    path.startsWith("/repos/e2e-org/demo-app/stacks?")
                  ? []
                  : undefined;
      if (answer === undefined) {
        const message = `fake GitHub API: unsupported request ${method} ${path} ${request.operationName ?? ""}${
          request.query === undefined ? "" : `\n${request.query}`
        }`;
        process.stderr.write(`${message}\n`);
        response.writeHead(501, { "content-type": "application/json" });
        response.end(JSON.stringify({ message, errors: [{ message }] }));
        return;
      }
      response.writeHead(workflow?.status ?? 200, { "content-type": "application/json" });
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
