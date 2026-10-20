import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Redacted from "effect/Redacted";

import { HttpClient, HttpClientResponse } from "effect/http";

import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// GitHub's field-level reviewer refusal; the surrounding response data is synthetic.
const refusedReviewer = {
  type: "FORBIDDEN",
  message: "Resource not accessible by integration",
  path: ["repository", "pullRequest", "reviewRequests", "nodes", 0, "requestedReviewer"],
};
const pullRequestInput = { cwd: "/w", repository: "acme/web", host: "github.com", number: 7 };
type PullRequestRead = (
  input: typeof pullRequestInput,
) => Effect.Effect<unknown, GitHubPullRequestApi.GitHubPullRequestApiError>;
const refusedReviewerResponse = () =>
  Effect.succeed(output(encodeJson({ ...coreResponse(), errors: [refusedReviewer] })));

const coreResponse = (pullRequest: Readonly<Record<string, unknown>> = {}) => ({
  data: {
    repository: {
      mergeCommitAllowed: true,
      squashMergeAllowed: false,
      rebaseMergeAllowed: true,
      autoMergeAllowed: true,
      viewerPermission: "WRITE",
      pullRequest: {
        number: 7,
        title: "Pull request 7",
        url: "https://github.com/acme/web/pull/7",
        body: "",
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        reviewDecision: null,
        additions: 0,
        deletions: 0,
        changedFiles: 0,
        mergedAt: null,
        closedAt: null,
        isCrossRepository: false,
        headRepositoryOwner: null,
        headRepository: null,
        headRef: null,
        author: null,
        autoMergeRequest: null,
        headRefName: "feature",
        baseRefName: "main",
        headRefOid: "abc123",
        state: "OPEN",
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-02T00:00:00Z",
        viewerCanUpdate: true,
        viewerDidAuthor: false,
        viewerCanUpdateBranch: true,
        baseRef: { compare: { behindBy: 2 } },
        reviewRequests: { nodes: [] },
        labels: { nodes: [] },
        commits: { nodes: [] },
        ...pullRequest,
      },
    },
  },
});

type ApiCall =
  | {
      readonly kind: "graphql";
      readonly partial?: boolean;
      /** The generated operation's name, which the routes below match on. */
      readonly operationName?: string;
      readonly host: string;
      readonly operation: string;
      readonly query: string;
      readonly variables?: Readonly<Record<string, unknown>>;
    }
  | ({ readonly kind: "rest" } & GitHubRest.GitHubRestInput);

type ApiAnswer = Effect.Effect<GitHubRest.GitHubRestResponse, GitHubRequestPolicy.GitHubApiError>;

const mockedExecute = vi.fn<(call: ApiCall) => ApiAnswer>();
let credentialGeneration = 0;
const defaultCredential = (host: string) =>
  Effect.succeed({
    token: Redacted.make("token"),
    fingerprint: `${host}:token:${credentialGeneration}`,
  });
const mockedCredential = vi.fn(defaultCredential);
const mockedStackMemberships = vi.fn<(call: ApiCall) => ApiAnswer>(() =>
  Effect.succeed(output('{"data":{}}')),
);

/** The REST transport, answered from the mocks above. */
const mockApi = Layer.succeed(
  GitHubRest.GitHubRest,
  GitHubRest.GitHubRest.of({
    rest: (input) => mockedExecute({ kind: "rest", ...input }),
    credential: (host) => mockedCredential(host),
  }),
);

/**
 * The HTTP side of the generated GraphQL reads, answered from the same mocks: a request to a
 * host's GraphQL endpoint is recorded as a `graphql` call, carrying the `partial` flag the batches
 * read with, and answered with the mocked body, status and headers.
 */
const mockHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.gen(function* () {
      const host = new URL(request.url).hostname.replace(/^api\./, "");
      const sent =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as {
              readonly query: string;
              readonly operationName: string;
              readonly variables: Readonly<Record<string, unknown>>;
            })
          : { query: "", operationName: "", variables: {} };
      const call: ApiCall = {
        kind: "graphql",
        host,
        operation: "batch",
        operationName: sent.operationName,
        query: sent.query,
        variables: sent.variables,
        partial: true,
      };
      // A mocked failure with a status is what GitHub would have answered with it.
      const answer = yield* (
        sent.query.startsWith("query PullRequestStackMembership(")
          ? mockedStackMemberships
          : mockedExecute
      )(call).pipe(
        Effect.catchTags({
          GitHubApiAuthenticationError: () => Effect.succeed(output("", false, false, {}, 401)),
          GitHubApiNotFoundError: () => Effect.succeed(output("", false, false, {}, 404)),
          GitHubApiRateLimitError: () => Effect.succeed(output("", false, false, {}, 429)),
          GitHubApiResponseError: (error) =>
            Effect.succeed(
              output(
                error.status === 200
                  ? encodeJson({
                      errors: (error.githubErrors ?? ["Refused"]).map((message) => ({ message })),
                    })
                  : '{"message":"Bad gateway"}',
                false,
                false,
                {},
                error.status,
              ),
            ),
        }),
        Effect.orDie,
      );
      // A mutation mocked as `{}` is one whose answer the test does not read. GitHub always
      // answers a mutation that ran with `data`, so it is sent as the null payload it selects.
      const body =
        answer.body === "{}" && sent.query.startsWith("mutation ")
          ? encodeJson(mutationAnswer(sent.query))
          : answer.body;
      return HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          status: answer.status,
          headers: { "content-type": "application/json", ...answer.headers },
        }),
      );
    }),
  ),
);

const layer = it.layer(
  GitHubPullRequestApi.layer.pipe(
    Layer.provideMerge(mockApi),
    Layer.provideMerge(GitHubRequestPolicy.layer),
    Layer.provideMerge(GitHubQuota.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
    Layer.provideMerge(mockHttp),
    Layer.provideMerge(
      Layer.succeed(GitHubCredentials.GitHubCredentials, {
        get: (host) =>
          Effect.map(mockedCredential(host), (held) => ({ ...held, host, source: "gh" as const })),
        invalidate: () => Effect.void,
      }),
    ),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(TestSourceControlHost.layer()),
    Layer.provide(NodeServices.layer),
  ),
);

function output(
  body: string,
  truncated = false,
  invalidUtf8 = false,
  headers: Readonly<Record<string, string>> = {},
  status = 200,
): GitHubRest.GitHubRestResponse {
  return { status, headers, body, truncated, invalidUtf8 };
}

const workflowTarget = { cwd: "/w", repository: "acme/web", host: "github.com", runId: 40 };
const workflowEndpoint = "repos/acme/web/actions/runs/40";
const waitingWorkflow = {
  name: "Promote",
  run_number: 3,
  run_attempt: 1,
  status: "waiting",
  conclusion: null,
  html_url: "https://github.com/acme/web/actions/runs/40",
  head_branch: "main",
  head_sha: "abc123",
  event: "workflow_run",
};
const pendingDeployment = (canApprove: boolean) => [
  { environment: { id: 21, name: "production" }, current_user_can_approve: canApprove },
];

function graphqlQuota(remaining: number, resetAt = "2099-08-13T14:00:00Z") {
  return {
    "x-ratelimit-resource": "graphql",
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": String(Date.parse(resetAt) / 1000),
  };
}

/** What every listing row answers with, which a fixture overrides only where it matters. */
const rowDefaults = {
  autoMergeRequest: null,
  author: null,
  state: "OPEN",
  isDraft: false,
  mergeable: "UNKNOWN",
  reviewDecision: null,
  latestReviews: { nodes: [] },
  mergedAt: null,
  reviewRequests: { nodes: [] },
  labels: { nodes: [] },
  commits: { nodes: [] },
};

/** A connection's page info with no next page, as GitHub sends it: the cursor is always there. */
const lastPage = { hasNextPage: false, endCursor: null };

/**
 * Listing rows as GraphQL answers them. Overrides may use the flat shapes a test reads most
 * easily: `reviewRequests` as `[{ login }]` or `[{ slug }]`, and `checks` as the rollup state.
 */
function rows(
  count: number,
  firstNumber: number,
  overrides: (number: number) => Readonly<Record<string, unknown>> = () => ({}),
): ReadonlyArray<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => {
    const number = firstNumber + index;
    const { reviewRequests, checks, ...rest } = overrides(number) as {
      reviewRequests?: ReadonlyArray<Record<string, string>>;
      checks?: string;
    } & Record<string, unknown>;
    return {
      ...rowDefaults,
      number,
      title: `Pull request ${number}`,
      url: `https://github.com/acme/web/pull/${number}`,
      headRefName: "feat/page",
      baseRefName: "main",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
      repository: { nameWithOwner: "acme/web" },
      ...(reviewRequests === undefined
        ? {}
        : {
            reviewRequests: {
              nodes: reviewRequests.map((requestedReviewer) => ({
                requestedReviewer: {
                  __typename: "slug" in requestedReviewer ? "Team" : "User",
                  ...requestedReviewer,
                },
              })),
            },
          }),
      ...(checks === undefined
        ? {}
        : { commits: { nodes: [{ commit: { statusCheckRollup: { state: checks } } }] } }),
      ...rest,
    };
  });
}

function pullRequests(
  count: number,
  firstNumber: number,
  overrides?: (number: number) => Readonly<Record<string, unknown>>,
): string {
  return encodeJson({
    data: {
      search: { pageInfo: lastPage, nodes: rows(count, firstNumber, overrides) },
    },
  });
}

function listedPullRequests(
  count: number,
  firstNumber: number,
  overrides?: (number: number) => Readonly<Record<string, unknown>>,
): string {
  return encodeJson({
    data: {
      repository: {
        pullRequests: {
          pageInfo: lastPage,
          nodes: rows(count, firstNumber, overrides),
        },
      },
    },
  });
}

const emptySearch = () => output(pullRequests(0, 1));
const emptyList = () => output(listedPullRequests(0, 1));

function pullRequestFiles(count: number, firstIndex: number): string {
  return encodeJson(
    Array.from({ length: count }, (_, index) => ({
      filename: `src/file${firstIndex + index}.ts`,
      status: "modified",
      patch: "@@ -1 +1 @@\n-old\n+new",
    })),
  );
}

function threadComments(
  ids: ReadonlyArray<string>,
  endCursor: string | null,
  totalCount = ids.length,
) {
  return {
    totalCount,
    pageInfo: { hasNextPage: endCursor !== null, endCursor },
    nodes: ids.map((id) => ({
      id,
      author: null,
      body: id,
      createdAt: "2026-07-01T00:00:00Z",
      lastEditedAt: null,
      url: `https://github.com/acme/web/pull/7#discussion_${id}`,
      reactionGroups: [],
    })),
  };
}

function thread(id: string, ...commentIds: ReadonlyArray<string>) {
  return {
    id,
    path: "src/a.ts",
    line: 1,
    diffSide: "RIGHT",
    isResolved: false,
    isOutdated: false,
    comments: threadComments(commentIds, null),
  };
}

function reviewThreadsPage(
  nodes: ReadonlyArray<Record<string, unknown>>,
  endCursor: string | null,
  requestedReviewers: ReadonlyArray<Record<string, unknown>> = [],
): string {
  return encodeJson({
    data: {
      viewer: { login: "viewer" },
      repository: {
        pullRequest: {
          reviewThreads: {
            totalCount: nodes.length,
            pageInfo: { hasNextPage: endCursor !== null, endCursor },
            nodes,
          },
          viewerCanUpdate: true,
          viewerDidAuthor: false,
          author: null,
          reactionGroups: [],
          comments: { nodes: [] },
          reviews: { nodes: [] },
          reviewRequests: {
            nodes: requestedReviewers.map((requestedReviewer) => ({ requestedReviewer })),
          },
          latestReviews: { nodes: [] },
          reviewDismissals: { pageInfo: lastPage, nodes: [] },
          commits: { nodes: [] },
        },
      },
    },
  });
}

function threadCommentsPage(
  ids: ReadonlyArray<string>,
  endCursor: string | null,
  totalCount: number,
  pullRequestId = "PR_7",
): string {
  return encodeJson({
    data: {
      viewer: { login: "viewer" },
      repository: { pullRequest: { id: "PR_7" } },
      node: {
        __typename: "PullRequestReviewThread",
        pullRequest: { id: pullRequestId },
        comments: threadComments(ids, endCursor, totalCount),
      },
    },
  });
}

/** What GitHub answers for a pull request it will not serve a whole diff for. */
const diffRefused = new GitHubRequestPolicy.GitHubApiResponseError({
  host: "github.com",
  operation: "getPullRequestDiff",
  status: 406,
});

function callAt(index: number): ApiCall {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}

function varsAt(index: number): Readonly<Record<string, unknown>> {
  const call = callAt(index);
  assert.strictEqual(call.kind, "graphql");
  return call.kind === "graphql" ? (call.variables ?? {}) : {};
}

function queryAt(index: number): string {
  const call = callAt(index);
  return call.kind === "graphql" ? call.query : "";
}

function pathAt(index: number): string {
  const call = callAt(index);
  return call.kind === "rest" ? call.path : "";
}

function searchOfCall(index: number): string | undefined {
  const q = callAt(index).kind === "graphql" ? varsAt(index)["q"] : undefined;
  return typeof q === "string" ? q : undefined;
}

function searchItem(number: number, repository: string, updatedAt: string) {
  return {
    ...rowDefaults,
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/${repository}/pull/${number}`,
    author: {
      __typename: "User",
      login: "octocat",
      avatarUrl: "https://avatars/octocat",
      name: null,
    },
    headRefName: "feat/page",
    baseRefName: "main",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt,
    repository: { nameWithOwner: repository },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "hubot" } }] },
    labels: { nodes: [{ name: "bug", color: "ff0000" }] },
  };
}

function searchPage(nodes: ReadonlyArray<unknown>, hasNextPage = false) {
  return output(
    encodeJson({
      data: {
        search: { pageInfo: { hasNextPage, endCursor: hasNextPage ? "next" : null }, nodes },
      },
    }),
  );
}

const searchQueryOfCall = searchOfCall;

/** Whether a request is the GraphQL operation `needle` names, or its document or path holds it. */
function matches(call: ApiCall, needle: string): boolean {
  return call.kind === "graphql"
    ? call.operationName === needle ||
        call.query.replace(/\s+/g, "").includes(needle.replace(/\s+/g, ""))
    : call.path.includes(needle);
}

/**
 * Answers every request with the body of the first route whose needle it matches, and any
 * unrouted mutation with the empty payload each one selects, which nothing reads back.
 */
function route(...routes: ReadonlyArray<readonly [needle: string, body: unknown]>): void {
  mockedExecute.mockImplementation((call) => {
    const match = routes.find(([needle]) => matches(call, needle));
    return Effect.succeed(
      output(
        match !== undefined
          ? encodeJson(match[1])
          : call.kind === "graphql" && call.query.startsWith("mutation ")
            ? encodeJson(mutationAnswer(call.query))
            : "{}",
      ),
    );
  });
}

/** What a mutation answers when nothing is asked of its payload: each root field, null. */
function mutationAnswer(query: string) {
  const root = /\)\{(\w+)(?:\(|\{|@)/.exec(query)?.[1];
  return { data: root === undefined ? {} : { [root]: null } };
}

/** The variables of every GraphQL request `needle` matches, in order. */
function variablesOf(needle: string): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return mockedExecute.mock.calls.flatMap(([call]) =>
    call.kind === "graphql" && matches(call, needle) ? [call.variables ?? {}] : [],
  );
}

/** Every REST request whose path contains `needle`, in order. */
function restCallsTo(needle: string): ReadonlyArray<GitHubRest.GitHubRestInput> {
  return mockedExecute.mock.calls.flatMap(([call]) =>
    call.kind === "rest" && call.path.includes(needle) ? [call] : [],
  );
}

/**
 * The check that a client-given node hangs off the pull request it names. Routed before the node
 * id lookup, whose document it contains.
 */
const SUBJECT_SCOPE_QUERY = "PullRequestSubject";
const subjectScope = (subjectId: string, pullRequestId: string) => ({
  data: {
    repository: { pullRequest: { id: pullRequestId } },
    node: { __typename: "IssueComment", id: subjectId, pullRequest: { id: pullRequestId } },
  },
});

/** A check run as the `CheckContext` fragment answers it, with `fields` over the defaults. */
const checkRun = (fields: Record<string, unknown>) => ({
  __typename: "CheckRun",
  name: "",
  status: "COMPLETED",
  conclusion: null,
  startedAt: null,
  completedAt: null,
  detailsUrl: null,
  checkSuite: { workflowRun: null },
  ...fields,
});

/** One page of a head commit's check contexts, the read a rollup past one page is walked by. */
const checkContextsPage = (
  nodes: ReadonlyArray<Record<string, unknown>>,
  endCursor: string | null,
  headRefOid = "abc123",
) =>
  encodeJson({
    data: {
      repository: {
        pullRequest: {
          headRefOid,
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } },
                  },
                },
              },
            ],
          },
        },
      },
    },
  });

const pullRequestRefs = encodeJson({ base: { sha: "a1b2c3d" }, head: { sha: "b1c2d3e" } });

const crossRepositoryDetail = (headRefOid = "abc123") =>
  coreResponse({
    headRefName: "feat/page",
    headRefOid,
    isCrossRepository: true,
    headRepositoryOwner: { __typename: "User", login: "octocat" },
  });

const heads = (numbers: ReadonlyArray<number>) => ({
  data: {
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: numbers.map((number) => ({
          number,
          headRefOid: "abc123",
          isCrossRepository: true,
          headRepositoryOwner: { __typename: "User", login: "octocat" },
        })),
      },
    },
  },
});

/** The head commit's check suites, one Actions run waiting on a maintainer in each. */
const workflowRuns = (
  ids: ReadonlyArray<number>,
  headBranch = "feat/page",
  endCursor: string | null = null,
) => ({
  data: {
    repository: {
      object: {
        __typename: "Commit",
        checkSuites: {
          pageInfo: { hasNextPage: endCursor !== null, endCursor },
          nodes: ids.map((id) => ({
            conclusion: "ACTION_REQUIRED",
            branch: { name: headBranch },
            workflowRun: {
              databaseId: id,
              url: `https://example.com/${id}`,
              event: "pull_request",
              workflow: { name: id === 10 ? "build" : `run ${id}` },
            },
          })),
        },
      },
    },
  },
});

const CHECK_SUITES_QUERY = "checkSuites(first: 100";

function workflowApprovalRoutes(
  detail: () => unknown,
  headsAnswer: unknown,
  runsAnswer: unknown,
): void {
  mockedExecute.mockImplementation((call) =>
    Effect.sync(() =>
      output(
        call.kind === "rest"
          ? call.path.endsWith("/approve")
            ? ""
            : encodeJson(runsAnswer)
          : call.operationName === "WorkflowApprovalSuites"
            ? encodeJson(runsAnswer)
            : call.operationName === "PullRequestHeads"
              ? encodeJson(headsAnswer)
              : encodeJson(detail()),
      ),
    ),
  );
}

/** The pull request node id lookup, which the layer caches for every test after the first. */
const NODE_ID_QUERY = "PullRequestNodeId";
const nodeIdAnswer = (id: string) => ({ data: { repository: { pullRequest: { id } } } });

afterEach(() => {
  credentialGeneration++;
  mockedExecute.mockReset();
  mockedStackMemberships.mockReset();
  mockedCredential.mockReset();
  mockedCredential.mockImplementation(defaultCredential);
});

it.effect(
  "keeps a verified credential through an auth switch and separates token fingerprints",
  () =>
    Effect.gen(function* () {
      let activeToken = "broad-credential";
      const requests: Array<{ readonly url: string; readonly authorization: string | undefined }> =
        [];
      const credentials = Layer.succeed(
        GitHubCredentials.GitHubCredentials,
        GitHubCredentials.GitHubCredentials.of({
          get: (host) =>
            Effect.sync(() => ({
              host,
              token: Redacted.make(activeToken),
              source: "gh" as const,
              fingerprint: `${host}:${activeToken.length}${activeToken.at(-1)}`,
            })),
          invalidate: () => Effect.void,
        }),
      );
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            requests.push({ url: request.url, authorization: request.headers["authorization"] });
            const body = request.url.endsWith("/user")
              ? { id: 123, login: "same-account" }
              : {
                  data: {
                    repository: { pullRequest: { id: "PR_1" } },
                    addComment: { clientMutationId: null },
                  },
                };
            return HttpClientResponse.fromWeb(
              request,
              new Response(encodeJson(body), { headers: { "content-type": "application/json" } }),
            );
          }),
        ),
      );
      const cli = yield* GitHubPullRequestApi.make.pipe(
        Effect.provide(
          GitHubRest.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(credentials, http)),
            Layer.provideMerge(GitHubQuota.layer),
            Layer.provideMerge(SourceControlRateLimit.layer),
            Layer.merge(TestSourceControlHost.layer()),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      );
      const input = { cwd: "/repo", host: "github.com" };
      const first = yield* cli.withVerifiedCredential(input, (identity) =>
        Effect.gen(function* () {
          activeToken = "restricted-credential";
          expect(yield* cli.getViewerLogin(input)).toBe("same-account");
          yield* cli.commentOnPullRequest({
            ...input,
            repository: "owner/repo",
            number: 1,
            body: "comment",
          });
          return identity;
        }),
      );
      const second = yield* cli.withVerifiedCredential(input, Effect.succeed);
      expect(first.accountId).toBe(second.accountId);
      expect(first.credentialFingerprint).not.toBe(second.credentialFingerprint);
      expect(encodeJson([first, second])).not.toContain("broad-credential");
      expect(encodeJson([first, second])).not.toContain("restricted-credential");
      expect(
        requests
          .filter((request) => request.url.endsWith("/graphql"))
          .map((request) => request.authorization),
      ).toEqual(["Bearer broad-credential", "Bearer broad-credential"]);
      expect(
        requests
          .filter((request) => request.url.endsWith("/user"))
          .map((request) => request.authorization),
      ).toEqual(["Bearer broad-credential", "Bearer restricted-credential"]);
      expect(yield* cli.getRoutingIdentity(input)).toEqual({
        accountId: "123",
        viewer: "same-account",
      });
    }),
);

layer("GitHubPullRequestApi.layer", (it) => {
  it.effect("holds background previews once an answer reports the reserve, until it resets", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const quota = yield* GitHubQuota.GitHubQuota;
      const resetAt = "2099-08-13T14:00:00Z";
      yield* quota.observe("preview-budget.example", graphqlQuota(501, resetAt));
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    number: 7,
                    title: "Fast previews",
                    url: "https://preview-budget.example/acme/web/pull/7",
                    state: "OPEN",
                    isDraft: false,
                    createdAt: "2026-07-01T00:00:00Z",
                    author: null,
                  },
                },
              },
            }),
            false,
            false,
            graphqlQuota(499, resetAt),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const input = {
        cwd: "/w",
        repository: "acme/web",
        host: "preview-budget.example",
        number: 7,
      };
      yield* cli.getPullRequestPreview(input);
      const held = yield* Effect.flip(cli.getPullRequestPreview({ ...input, number: 8 }));
      expect(held._tag).toBe("SourceControlRateLimitPausedError");
      expect(mockedExecute).toHaveBeenCalledTimes(1);
      yield* TestClock.setTime(Date.parse(resetAt));
      yield* cli.getPullRequestPreview(input);
      expect(mockedExecute).toHaveBeenCalledTimes(2);
      yield* TestClock.setTime(now);
    }),
  );

  it.effect("loads the complete hover card with one GraphQL request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    number: 7,
                    title: "Fast previews",
                    url: "https://github.example/acme/web/pull/7",
                    state: "MERGED",
                    isDraft: false,
                    createdAt: "2026-07-01T00:00:00Z",
                    author: {
                      __typename: "User",
                      login: "octocat",
                      name: "Octo Cat",
                      avatarUrl: "https://github.example/avatar.png",
                    },
                  },
                },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const preview = yield* cli.getPullRequestPreview({
        cwd: "/w",
        repository: "acme/web",
        host: "github.example",
        number: 7,
      });
      expect(preview).toEqual({
        number: 7,
        title: "Fast previews",
        url: "https://github.example/acme/web/pull/7",
        state: "merged",
        isDraft: false,
        createdAt: "2026-07-01T00:00:00Z",
        author: {
          login: "octocat",
          name: "Octo Cat",
          avatarUrl: "https://github.example/avatar.png",
        },
      });
      expect(mockedExecute).toHaveBeenCalledTimes(1);
      expect(callAt(0)).toMatchObject({ kind: "graphql", host: "github.example" });
    }),
  );

  it.effect("coalesces concurrent identity verification for the same host and credential", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(() =>
        Effect.yieldNow.pipe(Effect.as(output('{"id":123,"login":"viewer"}'))),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const results = yield* Effect.all(
        Array.from({ length: 4 }, () =>
          cli.getRoutingIdentity({ cwd: "/w", host: "github.identity-flight.test" }),
        ),
        { concurrency: 4 },
      );
      expect(results).toEqual(
        Array.from({ length: 4 }, () => ({ accountId: "123", viewer: "viewer" })),
      );
      expect(mockedExecute).toHaveBeenCalledTimes(1);
      expect(pathAt(0)).toBe("user");
    }),
  );

  it.effect(
    "lets another identity reader continue when the first verification is interrupted",
    () =>
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        let verifications = 0;
        mockedExecute.mockImplementation(() =>
          Effect.gen(function* () {
            if (++verifications === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              return yield* Effect.never;
            }
            return output('{"id":123,"login":"viewer"}');
          }),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const input = { cwd: "/w", host: "github.identity-cancel.test" };
        const first = yield* cli.getRoutingIdentity(input).pipe(Effect.forkChild);
        yield* Deferred.await(firstStarted);
        const second = yield* cli.getRoutingIdentity(input).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(first);
        expect(yield* Fiber.join(second)).toEqual({ accountId: "123", viewer: "viewer" });
        expect(verifications).toBe(2);
      }),
  );

  it.effect("reads linked pull requests on one host together, filed back by position", () =>
    Effect.gen(function* () {
      const node = (number: number) => ({
        number,
        title: `Pull request ${number}`,
        autoMergeRequest: number === 7 ? { enabledAt: "2026-08-24T12:34:56.000Z" } : null,
        isInMergeQueue: number === 7,
        url: `https://github.com/acme/web/pull/${number}`,
        author: {
          __typename: "User",
          login: "octocat",
          name: "Octo Cat",
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
        },
        baseRefName: "main",
        headRefName: `feat/${number}`,
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        reviewDecision: null,
        latestReviews: {
          nodes: [{ state: "APPROVED", author: { __typename: "User", login: "reviewer" } }],
        },
        additions: 12,
        deletions: 3,
        changedFiles: 2,
        updatedAt: "2026-08-24T12:34:56.000Z",
        mergedAt: null,
        closedAt: null,
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
      });
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                _0_repository: { pullRequest: node(7) },
                _1_repository: { pullRequest: node(8) },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const reads = yield* Effect.forEach(
        [7, 8],
        (number) =>
          cli.getPullRequestSummary({
            cwd: "/w",
            repository: "acme/web",
            host: "github.com",
            number,
          }),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 millis");
      const [seven, eight] = yield* Fiber.join(reads);
      assert.strictEqual(seven?.autoMergeEnabled, true);
      assert.strictEqual(seven?.inMergeQueue, true);
      assert.strictEqual(eight?.autoMergeEnabled, false);
      assert.strictEqual(eight?.inMergeQueue, false);

      assert.deepStrictEqual(
        {
          number: seven?.number,
          state: seven?.state,
          headBranch: seven?.headBranch,
          author: seven?.author?.login,
          changedFiles: seven?.changedFiles,
          reviewDecision: seven?.reviewDecision,
          checksState: seven?.checksState,
          mergeability: seven?.mergeability,
        },
        {
          number: 7,
          state: "open",
          headBranch: "feat/7",
          author: "octocat",
          changedFiles: 2,
          reviewDecision: "approved",
          checksState: "passing",
          mergeability: "mergeable",
        },
      );
      assert.strictEqual(eight?.headBranch, "feat/8");
      expect(mockedExecute).toHaveBeenCalledOnce();
      expect(queryAt(0)).toContain(
        "_0_repository:repository(owner:$_0_owner name:$_0_name){pullRequest(number:$_0_number)",
      );
      expect(varsAt(0)).toMatchObject({
        _0_owner: "acme",
        _0_name: "web",
        _0_number: 7,
        _0_stacks: true,
        _1_number: 8,
      });
    }),
  );

  it.effect("fingerprints watched pull requests on one host in one read", () =>
    Effect.gen(function* () {
      const node = (comments: number) => ({
        state: "OPEN",
        mergeable: "MERGEABLE",
        headRefOid: "abc123",
        comments: { totalCount: comments, nodes: [] },
        reviews: { totalCount: 0, nodes: [] },
        reviewThreads: { totalCount: 0 },
        commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
      });
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              data: {
                _0_repository: { pullRequest: node(1) },
                _1_repository: { pullRequest: null },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const reads = yield* Effect.forEach(
        [7, 8],
        (number) =>
          cli.getPullRequestWatchFingerprint({
            cwd: "/w",
            repository: "acme/web",
            host: "github.com",
            number,
          }),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 millis");
      const [seven, eight] = yield* Fiber.join(reads);

      expect(seven?.remarks.startsWith("1 ")).toBe(true);
      expect(eight).toBeNull();
      expect(mockedExecute).toHaveBeenCalledOnce();
      expect(queryAt(0)).toContain(
        "_1_repository:repository(owner:$_1_owner name:$_1_name){pullRequest(number:$_1_number)",
      );
      expect(varsAt(0)).toMatchObject({ _1_owner: "acme", _1_name: "web", _1_number: 8 });
    }),
  );

  it.effect(
    "fails only the pull request GitHub cannot find, and answers the rest of its batch",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(
            output(
              encodeJson({
                data: {
                  _0_repository: { pullRequest: null },
                  _1_repository: {
                    pullRequest: {
                      number: 8,
                      title: "Still here",
                      autoMergeRequest: null,
                      url: "https://github.com/acme/web/pull/8",
                      author: null,
                      baseRefName: "main",
                      headRefName: "feat/eight",
                      state: "OPEN",
                      isDraft: false,
                      mergeable: "MERGEABLE",
                      reviewDecision: null,
                      latestReviews: { nodes: [] },
                      additions: 1,
                      deletions: 1,
                      changedFiles: 1,
                      updatedAt: "2026-08-24T12:34:56.000Z",
                      mergedAt: null,
                      closedAt: null,
                      commits: { nodes: [] },
                      stack: null,
                      stackEntry: null,
                    },
                  },
                },
                errors: [
                  {
                    type: "NOT_FOUND",
                    path: ["_0_repository", "pullRequest"],
                    message: "Could not resolve to a PullRequest with the number of 7.",
                  },
                ],
              }),
            ),
          ),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

        const reads = yield* Effect.forEach(
          [7, 8],
          (number) =>
            cli
              .getPullRequestSummary({
                cwd: "/w",
                repository: "acme/web",
                host: "github.com",
                number,
              })
              .pipe(Effect.result),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("10 millis");
        const [seven, eight] = yield* Fiber.join(reads);

        expect(Result.isFailure(seven!) ? seven.failure._tag : null).toBe("GitHubApiNotFoundError");
        expect(Result.isSuccess(eight!) ? eight.success.headBranch : null).toBe("feat/eight");
        // One request answered both; nothing was read again on its own.
        expect(mockedExecute).toHaveBeenCalledOnce();
        expect(callAt(0)).toMatchObject({ kind: "graphql", partial: true });
      }),
  );

  it.effect("reads the stack a pull request is in through the stacks preview, on its host", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson([
              {
                id: 42,
                number: 3,
                url: "https://api.github.com/repos/acme/web/stacks/3",
                base: { ref: "main" },
                pull_requests: [
                  {
                    number: 6,
                    head: { ref: "feat/one" },
                    state: "closed",
                    merged_at: "2026-09-02",
                  },
                  { number: 7, head: { ref: "feat/two" }, state: "open", merged_at: null },
                ],
              },
            ]),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const stack = yield* cli.getPullRequestStack({
        cwd: "/w",
        repository: "acme/web",
        host: "ghe.example.com",
        number: 7,
      });

      assert.deepStrictEqual(stack, {
        id: "42",
        number: 3,
        url: "https://api.github.com/repos/acme/web/stacks/3",
        base: "main",
        layers: [
          { number: 6, headBranch: "feat/one", state: "merged" },
          { number: 7, headBranch: "feat/two", state: "open" },
        ],
      });
      expect(callAt(0)).toMatchObject({
        kind: "rest",
        host: "ghe.example.com",
        path: "repos/acme/web/stacks?pull_request=7",
      });
    }),
  );

  it.effect("revalidates a polled stack, per credential, so an unchanged one costs no quota", () =>
    Effect.gen(function* () {
      const listing = encodeJson([
        {
          number: 4,
          url: "https://api.github.com/repos/acme/poll/stacks/4",
          base: { ref: "main" },
          pull_requests: [
            { number: 9, head: { ref: "feat/nine" }, state: "open", merged_at: null },
          ],
        },
      ]);
      const read = Effect.flatMap(GitHubPullRequestApi.GitHubPullRequestApi, (cli) =>
        cli.getPullRequestStack({
          cwd: "/w",
          repository: "acme/poll",
          host: "github.com",
          number: 9,
        }),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(listing, false, false, { etag: 'W/"v1"' })),
      );
      const first = yield* read;
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("", false, false, {}, 304)));
      const second = yield* read;
      mockedCredential.mockImplementationOnce(() =>
        Effect.succeed({ token: Redacted.make("other"), fingerprint: "github.com:other" }),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(listing)));
      yield* read;

      assert.deepStrictEqual(second, first);
      expect(callAt(0)).not.toHaveProperty("ifNoneMatch");
      expect(callAt(1)).toMatchObject({ ifNoneMatch: 'W/"v1"' });
      // Another account never revalidates the first account's answer.
      expect(callAt(2)).not.toHaveProperty("ifNoneMatch");
    }),
  );

  it.effect("fetches layer titles only when the caller asks for stack details", () =>
    Effect.gen(function* () {
      const minimal = {
        url: "https://api.github.com/repos/acme/web/stacks/3",
        number: 3,
        base: { ref: "main" },
        pull_requests: [
          { number: 7, head: { ref: "feat/two", sha: "abc123" }, state: "open", merged_at: null },
        ],
      };
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(encodeJson([minimal]))));
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              ...minimal,
              pull_requests: [{ ...minimal.pull_requests[0], title: "Second layer", draft: false }],
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const stack = yield* cli.getPullRequestStack({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        includeDetails: true,
      });
      expect(stack?.layers[0]).toMatchObject({
        title: "Second layer",
        headSha: "abc123",
        isDraft: false,
      });
      expect(pathAt(1)).toBe("repos/acme/web/stacks/3");
    }),
  );

  it.effect("reads an empty stacks listing as not stacked", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const stack = yield* cli.getPullRequestStack({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.isNull(stack);
    }),
  );

  it.effect("reads a host that refuses the stacks preview as not stacked", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.fail(
          new GitHubRequestPolicy.GitHubApiNotFoundError({
            host: "github.com",
            operation: "getPullRequestStack",
          }),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const stack = yield* cli.getPullRequestStack({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.isNull(stack);
    }),
  );

  it.effect("does not read a refused credential as an unstacked pull request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.fail(
          new GitHubRequestPolicy.GitHubApiAuthenticationError({
            host: "github.com",
            operation: "getPullRequestStack",
          }),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestStack({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );

      assert.strictEqual(error._tag, "GitHubApiAuthenticationError");
    }),
  );

  it.effect("preserves transient stack failures instead of reporting no stack", () =>
    Effect.gen(function* () {
      const failure = new GitHubRequestPolicy.GitHubApiResponseError({
        host: "github.com",
        operation: "getPullRequestStack",
        status: 503,
      });
      mockedExecute.mockReturnValueOnce(Effect.fail(failure));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const error = yield* Effect.flip(
        cli.getPullRequestStack({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );
      assert.strictEqual(error, failure);
    }),
  );

  it.effect("reports a stacks answer it cannot read against the stack read", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output('[{"id":42}]')));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestStack({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );

      assert.strictEqual(error._tag, "GitHubPullRequestReadError");
      if (error._tag !== "GitHubPullRequestReadError") return;
      assert.strictEqual(error.operation, "getPullRequestStack");
    }),
  );

  it.effect("asks for one row more than the page, to probe for a next page", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(3, 1))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.strictEqual(batch.items.length, 3);
      assert.isFalse(batch.truncated);
      expect(callAt(0)).toMatchObject({ kind: "graphql", host: "github.com" });
      expect(searchOfCall(0)).toBe("is:pr is:open sort:updated-desc repo:acme/web");
      expect(varsAt(0)["first"]).toBe(11);
    }),
  );

  it.effect("reports truncation from the extra row, counted before decoding", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(11, 1))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.strictEqual(batch.items.length, 10);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("reports truncation when GitHub repeats a cursor before the page is full", () =>
    Effect.gen(function* () {
      const repeating = output(
        encodeJson({
          data: {
            search: {
              pageInfo: { hasNextPage: true, endCursor: "same" },
              nodes: rows(100, 1),
            },
          },
        }),
      );
      mockedExecute.mockReturnValue(Effect.succeed(repeating));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 250,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("excludes merged pull requests from the Closed tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.operationName?.startsWith("PullRequestList")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "closed",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      expect(searchOfCall(0)).toBe("is:pr is:closed is:unmerged sort:updated-desc repo:acme/web");
    }),
  );

  it.effect("narrows to the author on the authored tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.operationName?.startsWith("PullRequestList")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "authored",
        viewer: "bilal",
        limit: 10,
      });

      expect(searchOfCall(0)).toBe("is:pr is:open author:bilal sort:updated-desc repo:acme/web");
    }),
  );

  it.effect("narrows through search on the reviewing tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.operationName?.startsWith("PullRequestList")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 10,
      });

      expect(searchOfCall(0)).toBe(
        "is:pr is:open review-requested:bilal sort:updated-desc repo:acme/web",
      );
    }),
  );

  it.effect("carries every repository and every qualifier into one search", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(searchPage([])));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.searchPullRequests({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web", "pingdotgg/t3code"],
        state: "closed",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 10,
        query: "pull requests page",
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 10 },
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      assert.strictEqual(
        searchQueryOfCall(0),
        'is:pr is:closed is:unmerged review-requested:bilal "pull requests page" ' +
          "updated:<=2026-07-02T00:00:00Z sort:updated-desc repo:acme/web repo:pingdotgg/t3code",
      );
    }),
  );

  it.effect("narrows a search to the author, and to merged on the merged tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(searchPage([])));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.searchPullRequests({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web"],
        state: "merged",
        involvement: "authored",
        viewer: "bilal",
        limit: 10,
      });

      assert.strictEqual(
        searchQueryOfCall(0),
        "is:pr is:merged author:bilal sort:updated-desc repo:acme/web",
      );
    }),
  );

  it.effect("keeps a searched-for qualifier inside the phrase", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(searchPage([])));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.searchPullRequests({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web"],
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: 'x" is:merged repo:evil/repo',
      });

      assert.strictEqual(
        searchQueryOfCall(0),
        'is:pr is:open "x\\" is:merged repo:evil/repo" sort:updated-desc repo:acme/web',
      );
    }),
  );

  it.effect("refuses to search for a repository GitHub cannot address", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const failure = yield* Effect.flip(
        cli.searchPullRequests({
          cwd: "/w",
          host: "github.com",
          repositories: ["acme/web", "acme/web is:merged"],
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
        }),
      );

      assert.strictEqual(failure._tag, "GitHubRepositorySelectorError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("files each searched row under the repository it came from", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          searchPage([
            searchItem(7, "acme/web", "2026-07-03T00:00:00Z"),
            searchItem(9, "pingdotgg/t3code", "2026-07-02T00:00:00Z"),
            {},
          ]),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.searchPullRequests({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web", "pingdotgg/t3code"],
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.deepStrictEqual(
        batch.items.map((item) => [item.repository, item.number, item.author?.avatarUrl]),
        [
          ["acme/web", 7, "https://avatars/octocat"],
          ["pingdotgg/t3code", 9, "https://avatars/octocat"],
        ],
      );
      assert.deepStrictEqual(
        batch.items.map((item) => [item.additions, item.deletions]),
        [
          [0, 0],
          [0, 0],
        ],
      );
      assert.isFalse(batch.truncated);
    }),
  );

  it.effect("reports truncation from the extra row, and from a page GitHub says has more", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            searchPage([
              searchItem(1, "acme/web", "2026-07-03T00:00:00Z"),
              searchItem(2, "acme/web", "2026-07-02T00:00:00Z"),
              searchItem(3, "acme/web", "2026-07-01T00:00:00Z"),
            ]),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(searchPage([searchItem(1, "acme/web", "2026-07-03T00:00:00Z")], true)),
        );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const read = () =>
        cli.searchPullRequests({
          cwd: "/w",
          host: "github.com",
          repositories: ["acme/web"],
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 2,
        });

      const overflowing = yield* read();
      const capped = yield* read();

      assert.strictEqual(overflowing.items.length, 2);
      assert.isTrue(overflowing.truncated);
      assert.isTrue(capped.truncated);
    }),
  );

  it.effect("enriches only the visible fallback rows after filtering and widening", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(listedPullRequests(3, 1, () => ({ isDraft: true })))),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(listedPullRequests(6, 1, (number) => ({ isDraft: number < 4 })))),
      );
      mockedStackMemberships.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                _0_repository: {
                  pullRequest: {
                    stack: { number: 3, size: 2, baseRefName: "main" },
                    stackEntry: { position: 1 },
                  },
                },
                _1_repository: { pullRequest: { stack: null, stackEntry: null } },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 2,
        filters: { draft: "hide" },
      });
      expect(batch.items.map((item) => item.number)).toEqual([4, 5]);
      expect(batch.items[0]?.stack).toEqual({ number: 3, size: 2, base: "main", position: 1 });
      expect(batch.items[1]?.stack).toBeUndefined();
      expect(batch.truncated).toBe(true);
      expect(batch.continues).toBe(false);
      expect(mockedStackMemberships).toHaveBeenCalledTimes(1);
      const membership = mockedStackMemberships.mock.calls[0]?.[0];
      const numbers = Object.entries(
        membership?.kind === "graphql" ? (membership.variables ?? {}) : {},
      )
        .filter(([name]) => name.endsWith("_number"))
        .map(([, number]) => number);
      expect(numbers).toEqual([4, 5]);
    }),
  );

  it.effect("batches membership reads and keeps successful rows when one chunk fails", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(27, 1))));
      mockedStackMemberships.mockImplementation((input) =>
        input.kind === "graphql" && Object.values(input.variables ?? {}).includes(26)
          ? Effect.fail(
              new GitHubRequestPolicy.GitHubApiResponseError({
                host: "github.com",
                operation: "listPullRequestStackMemberships",
                status: 502,
              }),
            )
          : Effect.succeed(
              output(
                encodeJson({
                  data: Object.fromEntries(
                    Object.keys(input.kind === "graphql" ? (input.variables ?? {}) : {})
                      .filter((name) => name.endsWith("_number"))
                      .map((name, index) => [
                        name.replace(/number$/, "repository"),
                        {
                          pullRequest:
                            index === 0
                              ? {
                                  stack: { number: 3, size: 2, baseRefName: "main" },
                                  stackEntry: { position: 1 },
                                }
                              : { stack: null, stackEntry: null },
                        },
                      ]),
                  ),
                }),
              ),
            ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 26,
      });
      expect(batch.items.map((item) => item.number)).toEqual(
        Array.from({ length: 26 }, (_, i) => i + 1),
      );
      expect(batch.items[0]?.stack).toEqual({ number: 3, size: 2, base: "main", position: 1 });
      expect(batch.items[25]?.stack).toBeUndefined();
      expect(batch.truncated).toBe(true);
      expect(batch.continues).toBe(true);
      expect(mockedStackMemberships).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect(
    "reads queue membership without stack enrichment and omits unsupported fields on Enterprise",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockImplementation((call) =>
          Effect.succeed(
            output(
              encodeJson(
                call.kind === "graphql" && call.operationName?.startsWith("PullRequestSummary")
                  ? {
                      data: {
                        _0_repository: {
                          pullRequest: {
                            ...coreResponse().data.repository.pullRequest,
                            latestReviews: { nodes: [] },
                          },
                        },
                      },
                    }
                  : {
                      data: {
                        search: {
                          pageInfo: lastPage,
                          nodes: [
                            {
                              ...searchItem(7, "acme/web", "2026-07-02T00:00:00Z"),
                              ...(call.kind === "graphql" && call.variables?.["queue"] === true
                                ? { isInMergeQueue: true }
                                : {}),
                            },
                          ],
                        },
                      },
                    },
              ),
            ),
          ),
        );
        const api = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const input = {
          cwd: "/w",
          repository: "acme/web",
          state: "open" as const,
          involvement: "all" as const,
          viewer: "viewer",
          limit: 2,
        };
        expect(
          (yield* api.listPullRequests({ ...input, host: "github.com" })).items[0]?.inMergeQueue,
        ).toBe(true);
        expect(varsAt(0)).toMatchObject({ stacks: false, queue: true });
        expect(
          (yield* api.listPullRequests({ ...input, host: "github.example.test" })).items[0]
            ?.inMergeQueue,
        ).toBeUndefined();
        expect(queryAt(1)).not.toContain("isInMergeQueue");
        expect(queryAt(1)).not.toContain("stackEntry");
        const summary = yield* Effect.forkChild(
          api.getPullRequestSummary({ ...input, number: 7, host: "github.example.test" }),
        );
        yield* TestClock.adjust("10 millis");
        expect((yield* Fiber.join(summary)).inMergeQueue).toBeUndefined();
        expect(queryAt(2)).not.toContain("isInMergeQueue");
        expect(queryAt(2)).not.toContain("stackEntry");
      }),
  );

  it.effect("skips membership enrichment for empty pages and enterprise hosts", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
      mockedExecute.mockReturnValueOnce(Effect.succeed(emptyList()));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(1, 7))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const input = {
        cwd: "/w",
        repository: "acme/web",
        state: "open" as const,
        involvement: "all" as const,
        viewer: "bilal",
        limit: 2,
      };
      const empty = yield* cli.listPullRequests({ ...input, host: "github.com" });
      const enterprise = yield* cli.listPullRequests({ ...input, host: "github.acme.test" });
      expect(empty.items).toEqual([]);
      expect(enterprise.items.map((item) => item.number)).toEqual([7]);
      expect(mockedStackMemberships).not.toHaveBeenCalled();
    }),
  );

  it.effect("reads the line counts in chunks, and files them back by position", () =>
    Effect.gen(function* () {
      const changeRequests = Array.from({ length: 26 }, (_, index) => ({
        repository: "acme/web",
        number: index + 1,
      }));
      mockedExecute.mockImplementation((call) =>
        // Every chunk finds only its first pull request, so a row GitHub had nothing for is
        // dropped rather than shown as a change of no size.
        Effect.succeed(
          output(
            encodeJson({
              data: Object.fromEntries(
                Object.keys(call.kind === "graphql" ? (call.variables ?? {}) : {})
                  .filter((name) => name.endsWith("_number"))
                  .map((name, index) => [
                    name.replace(/number$/, "repository"),
                    { pullRequest: index === 0 ? { additions: 4, deletions: 1 } : null },
                  ]),
              ),
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const stats = yield* cli.listPullRequestStats({
        cwd: "/w",
        host: "github.com",
        changeRequests,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      assert.deepStrictEqual(stats, [
        { repository: "acme/web", number: 1, additions: 4, deletions: 1 },
        { repository: "acme/web", number: 26, additions: 4, deletions: 1 },
      ]);
      expect(queryAt(0)).toContain("_0_repository:repository(owner:$_0_owner name:$_0_name)");
      expect(varsAt(0)).toMatchObject({ _0_owner: "acme", _0_name: "web", _24_number: 25 });
    }),
  );

  it.effect("refuses to look up counts for a repository GitHub cannot address", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const failure = yield* Effect.flip(
        cli.listPullRequestStats({
          cwd: "/w",
          host: "github.com",
          changeRequests: [{ repository: 'acme/web") { x } #', number: 1 }],
        }),
      );

      assert.strictEqual(failure._tag, "GitHubRepositorySelectorError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("hands a search to GitHub rather than to the rows already read", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.operationName?.startsWith("PullRequestList")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: "pull requests page",
      });

      expect(searchOfCall(0)).toBe(
        'is:pr is:open "pull requests page" sort:updated-desc repo:acme/web',
      );
    }),
  );

  it.effect("joins a search onto the tab's own qualifiers instead of replacing them", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.operationName?.startsWith("PullRequestList")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "closed",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 10,
        query: "page",
      });

      expect(searchOfCall(0)).toBe(
        'is:pr is:closed is:unmerged review-requested:bilal "page" sort:updated-desc repo:acme/web',
      );
    }),
  );

  it.effect("carries the further narrowings into the search as qualifiers", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.operationName?.startsWith("PullRequestList")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        filters: {
          draft: "hide",
          review: "changes-requested",
          checks: "failing",
          labels: [["needs design"], ['quo"te']],
          excludedLabels: ["wip"],
          author: "octocat",
        },
      });

      expect(searchOfCall(0)).toBe(
        'is:pr is:open label:"needs design" label:"quote" -label:"wip" author:"octocat" ' +
          "draft:false review:changes_requested status:failure sort:updated-desc repo:acme/web",
      );
    }),
  );

  it.effect('resolves an author filter of "me" to the viewer, not the literal word', () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.operationName?.startsWith("PullRequestList")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        filters: { author: "me" },
      });

      expect(searchOfCall(0)).toBe('is:pr is:open author:"bilal" sort:updated-desc repo:acme/web');
    }),
  );

  it.effect("sends one label qualifier per group, its names joined the way GitHub ors them", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.operationName?.startsWith("PullRequestList")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        filters: { labels: [["size:S", "size:XS"], ["bug"]] },
      });

      expect(searchOfCall(0)).toBe(
        'is:pr is:open label:"size:S","size:XS" label:"bug" sort:updated-desc repo:acme/web',
      );
    }),
  );

  it.effect(
    "falls back for a repository the index does not cover under a checks filter, keeping only the matching rows",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(
            output(
              listedPullRequests(2, 1, (number) => ({
                checks: number === 1 ? "SUCCESS" : "FAILURE",
              })),
            ),
          ),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

        const batch = yield* cli.listPullRequests({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
          filters: { checks: "passing" },
        });

        expect(searchOfCall(1)).toBeUndefined();
        assert.deepStrictEqual(
          batch.items.map((item) => item.number),
          [1],
        );
      }),
  );

  it.effect("fails a checks filter for a row whose checks are still pending", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(listedPullRequests(1, 1, () => ({ checks: "PENDING" })))),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        filters: { checks: "passing" },
      });

      assert.deepStrictEqual(batch.items, []);
    }),
  );

  it.effect(
    "falls back for a repository the index does not cover even under a judgeable filter",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(output(listedPullRequests(2, 1, (number) => ({ isDraft: number === 1 })))),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

        const batch = yield* cli.listPullRequests({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
          filters: { draft: "hide" },
        });

        expect(searchOfCall(1)).toBeUndefined();
        expect(batch.items.map((item) => item.number)).toEqual([2]);
      }),
  );

  it.effect("carries the further narrowings into a batched search", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(searchPage([])));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.searchPullRequests({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web"],
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        filters: { draft: "only", review: "none", labels: [["bug"]] },
      });

      assert.strictEqual(
        searchQueryOfCall(0),
        'is:pr is:open label:"bug" draft:true review:none sort:updated-desc repo:acme/web',
      );
    }),
  );

  it.effect("quotes a search, so it cannot add a qualifier or a flag of its own", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.operationName?.startsWith("PullRequestList")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: '-- is:merged label:secret "widen me"',
      });

      expect(searchOfCall(0)).toBe(
        String.raw`is:pr is:open "-- is:merged label:secret \"widen me\"" sort:updated-desc repo:acme/web`,
      );
    }),
  );

  it.effect("escapes a backslash before the quote it would otherwise let out", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.operationName?.startsWith("PullRequestList")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: String.raw`a\" is:merged`,
      });

      expect(searchOfCall(0)).toBe(
        String.raw`is:pr is:open "a\\\" is:merged" sort:updated-desc repo:acme/web`,
      );
    }),
  );

  it.effect("asks for nothing but the order when the reader typed only spaces", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.operationName?.startsWith("PullRequestList")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: "   ",
      });

      expect(searchOfCall(0)).toBe("is:pr is:open sort:updated-desc repo:acme/web");
    }),
  );

  it.effect("carries on from the instant the last slice ended on", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output(pullRequests(3, 1))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 10 },
      });

      expect(searchOfCall(0)).toBe(
        "is:pr is:open updated:<=2026-07-02T00:00:00Z sort:updated-desc repo:acme/web",
      );
      assert.isTrue(batch.continues);
    }),
  );

  it.effect("answers a search that found nothing with nothing, not with the whole repository", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: "fdsfklj",
      });

      assert.strictEqual(batch.items.length, 0);
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );

  it.effect("reads a repository GitHub will not search from its own list", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(listedPullRequests(3, 1, () => ({ state: "CLOSED" })))),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "closed",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.strictEqual(batch.items.length, 3);
      expect(searchOfCall(1)).toBeUndefined();
      expect(varsAt(1)).toMatchObject({ owner: "acme", name: "web", states: ["CLOSED", "MERGED"] });
      assert.isFalse(batch.continues);
    }),
  );

  it.effect("keeps state and involvement filters on the search-free fallback", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            listedPullRequests(4, 1, (number) => ({
              state: number === 4 ? "OPEN" : "CLOSED",
              ...(number === 3 ? { mergedAt: "2026-07-03T00:00:00Z" } : {}),
              reviewRequests:
                number === 2 ? [{ slug: "platform", name: "Platform" }] : [{ login: "bilal" }],
            })),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "closed",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 10,
      });

      expect(batch.items.map((item) => item.number)).toEqual([1, 2]);
      expect(searchOfCall(1)).toBeUndefined();
      assert.isFalse(batch.continues);
    }),
  );

  it.effect("grows the search-free fallback until it fills the filtered page", () =>
    Effect.gen(function* () {
      const unrelated = () => ({ reviewRequests: [{ login: "somebody-else" }] });
      mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(listedPullRequests(3, 1, unrelated))),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            listedPullRequests(4, 1, (number) =>
              number === 4 ? { reviewRequests: [{ login: "bilal" }] } : unrelated(),
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 2,
      });

      expect(batch.items.map((item) => item.number)).toEqual([4]);
      expect(varsAt(1)["first"]).toBe(3);
      expect(varsAt(2)["first"]).toBe(6);
      assert.isFalse(batch.truncated);
    }),
  );

  it.effect("bounds a sparse search-free fallback and reports the unread tail", () =>
    Effect.gen(function* () {
      let listed = 0;
      mockedExecute.mockImplementation((call) => {
        if (call.kind !== "graphql" || call.operationName !== "PullRequestList") {
          return Effect.succeed(emptySearch());
        }
        const first = Number(call.variables?.["first"]);
        const nodes = rows(first, listed + 1, () => ({
          reviewRequests: [{ login: "somebody-else" }],
        }));
        listed += first;
        return Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  pullRequests: { pageInfo: { hasNextPage: true, endCursor: `c${listed}` }, nodes },
                },
              },
            }),
          ),
        );
      });
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 2,
      });

      const last = mockedExecute.mock.calls.length - 1;
      expect(varsAt(last)["after"]).toBe(`c${listed - 100}`);
      expect(listed - (3 + 6 + 12 + 24 + 48 + 96 + 192 + 384 + 768)).toBe(1000);
      assert.strictEqual(batch.items.length, 0);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("takes an empty slice for a repository that has run out, not one to read again", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.operationName?.startsWith("PullRequestList")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 10 },
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );

  const actionState = (pullRequest: Readonly<Record<string, unknown>> = {}) => ({
    data: {
      repository: {
        pullRequest: {
          id: "PR_7",
          headRefOid: "abc123",
          isMergeQueueEnabled: false,
          mergeStateStatus: "BLOCKED",
          baseRef: { compare: { behindBy: 2 } },
          ...pullRequest,
        },
      },
    },
  });
  const mergeMessage = (body: string, isMergeQueueEnabled = false) => ({
    data: {
      repository: {
        pullRequest: { isMergeQueueEnabled, headRefOid: "abc123", viewerMergeBodyText: body },
      },
    },
  });

  it.effect("updates a stale branch with a merge commit unless asked to rebase", () =>
    Effect.gen(function* () {
      route(["query PullRequestActionState", actionState()]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "update-branch",
      });
      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "update-branch",
        updateMethod: "rebase",
      });

      expect(variablesOf("updatePullRequestBranch(")).toEqual([
        { pullRequestId: "PR_7", expectedHeadOid: "abc123", updateMethod: "MERGE" },
        { pullRequestId: "PR_7", expectedHeadOid: "abc123", updateMethod: "REBASE" },
      ]);
    }),
  );

  it.effect("merges with the strategy it was asked for", () =>
    Effect.gen(function* () {
      route(["query PullRequestActionState", actionState()]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "merge",
        mergeMethod: "squash",
      });

      expect(variablesOf("mergePullRequest(")).toEqual([
        { input: { pullRequestId: "PR_7", mergeMethod: "SQUASH" } },
      ]);
      expect(variablesOf("enablePullRequestAutoMerge(")).toEqual([]);
    }),
  );

  it.effect.each([
    {
      description: "base-only write",
      basePermission: "WRITE",
      sourcePermission: "READ",
      headRef: { id: "REF" },
      expected: false,
      actionAllowed: false,
    },
    {
      description: "source-only write",
      basePermission: "READ",
      sourcePermission: "WRITE",
      headRef: { id: "REF" },
      expected: true,
      actionAllowed: true,
    },
    {
      description: "a deleted branch",
      basePermission: "READ",
      sourcePermission: "WRITE",
      headRef: null,
      expected: false,
      actionAllowed: true,
    },
    {
      description: "an unavailable source repository",
      basePermission: "WRITE",
      sourcePermission: null,
      headRef: { id: "REF" },
      expected: false,
      actionAllowed: false,
    },
  ])(
    "uses source branch access in both permission reads for $description",
    ({ basePermission, sourcePermission, headRef, expected, actionAllowed }) =>
      Effect.gen(function* () {
        const answer = coreResponse({
          headRepository:
            sourcePermission === null
              ? null
              : { nameWithOwner: "acme/web", viewerPermission: sourcePermission },
          headRef,
        });
        answer.data.repository.viewerPermission = basePermission;
        mockedExecute.mockReturnValue(Effect.succeed(output(encodeJson(answer))));
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const input = { cwd: "/w", repository: "acme/web", host: "github.com", number: 7 };
        expect((yield* cli.getViewerAccess(input)).canDeleteBranch).toBe(actionAllowed);
        expect((yield* cli.getPullRequestDetail(input)).viewerAccess.canDeleteBranch).toBe(
          expected,
        );
        expect(variablesOf("ViewerPermissions")).toHaveLength(1);
        expect(variablesOf("PullRequestCore")).toHaveLength(1);
      }),
  );

  it.effect("preserves the actual source fork name in provider detail", () =>
    Effect.gen(function* () {
      const answer = coreResponse({
        state: "MERGED",
        isCrossRepository: true,
        headRepository: { nameWithOwner: "contributor/web-fork", viewerPermission: "WRITE" },
        headRef: { id: "REF" },
      });
      mockedExecute.mockReturnValue(Effect.succeed(output(encodeJson(answer))));
      const provider = yield* GitHubPullRequestProvider.make;
      const detail = yield* provider.getChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });
      expect(detail.headRepositoryNameWithOwner).toBe("contributor/web-fork");
      expect(detail.viewerPermissions.actions).toContain("delete-branch");
      expect(queryAt(0)).toContain("headRepository{nameWithOwner viewerPermission}");
    }),
  );

  it.effect.each([
    { mergeStateStatus: "BLOCKED", autoMergeAllowed: true, offered: true },
    { mergeStateStatus: "UNKNOWN", autoMergeAllowed: true, offered: true },
    { mergeStateStatus: "CLEAN", autoMergeAllowed: true, offered: false },
    { mergeStateStatus: "UNSTABLE", autoMergeAllowed: true, offered: false },
    { mergeStateStatus: "HAS_HOOKS", autoMergeAllowed: true, offered: false },
    { mergeStateStatus: "BLOCKED", autoMergeAllowed: false, offered: false },
  ])(
    "gates auto-merge detail and fresh access for $mergeStateStatus (repository allows: $autoMergeAllowed)",
    ({ mergeStateStatus, autoMergeAllowed, offered }) =>
      Effect.gen(function* () {
        const answer = coreResponse({ mergeStateStatus });
        answer.data.repository.autoMergeAllowed = autoMergeAllowed;
        mockedExecute.mockReturnValue(Effect.succeed(output(encodeJson(answer))));
        const provider = yield* GitHubPullRequestProvider.make;
        const reference = {
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        };
        const detail = yield* provider.getChangeRequest(reference);
        expect(detail.viewerPermissions.actions.includes("enable-auto-merge")).toBe(offered);
        expect(detail.viewerPermissions.actions).toEqual(
          expect.arrayContaining(["merge", "disable-auto-merge"]),
        );

        const permissions = yield* provider.getViewerPermissions({
          ...reference,
          includeUpdateBranch: false,
        });
        expect(permissions.actions.includes("enable-auto-merge")).toBe(autoMergeAllowed);
        expect(permissions.actions).toEqual(
          expect.arrayContaining(["merge", "disable-auto-merge"]),
        );
      }),
  );

  const branchToDelete = (pullRequest: Readonly<Record<string, unknown>> = {}) => ({
    data: {
      repository: {
        pullRequest: {
          state: "MERGED",
          headRefName: "feat/delete",
          baseRefName: "main",
          headRefOid: "abc123",
          headRepository: { id: "FORK_REPO" },
          ...pullRequest,
        },
      },
    },
  });
  const sourceBranch = (repository: Readonly<Record<string, unknown>> = {}) => ({
    data: {
      node: {
        __typename: "Repository",
        defaultBranchRef: { name: "main" },
        ref: { target: { __typename: "Commit", oid: "abc123" } },
        ...repository,
      },
    },
  });

  it.effect.each(["MERGED", "CLOSED"])("deletes the exact remote fork branch of a %s PR", (state) =>
    Effect.gen(function* () {
      route(
        ["PullRequestBranchToDelete", branchToDelete({ state })],
        ["PullRequestSourceBranch", sourceBranch()],
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.enterprise.test",
        number: 7,
        action: "delete-branch",
      });
      expect(variablesOf("PullRequestBranchToDelete")).toEqual([
        { owner: "acme", name: "web", number: 7 },
      ]);
      expect(variablesOf("PullRequestSourceBranch")).toEqual([
        { repositoryId: "FORK_REPO", ref: "refs/heads/feat/delete" },
      ]);
      expect(variablesOf("updateRefs(")).toEqual([
        {
          input: {
            repositoryId: "FORK_REPO",
            refUpdates: [
              {
                name: "refs/heads/feat/delete",
                beforeOid: "abc123",
                afterOid: "0000000000000000000000000000000000000000",
              },
            ],
          },
        },
      ]);
      expect(mockedExecute.mock.calls.at(-1)?.[0].host).toBe("github.enterprise.test");
      expect(variablesOf("mergePullRequest(")).toEqual([]);
      expect(variablesOf("closePullRequest(")).toEqual([]);
    }),
  );

  it.effect.each([
    { description: "an open PR", head: { state: "OPEN" }, source: {} },
    { description: "a missing source repository", head: { headRepository: null }, source: {} },
    { description: "the base branch", head: { headRefName: "main" }, source: {} },
    {
      description: "the default branch",
      head: {},
      source: { defaultBranchRef: { name: "feat/delete" } },
    },
    { description: "a missing default branch", head: {}, source: { defaultBranchRef: null } },
    {
      description: "a changed branch",
      head: {},
      source: { ref: { target: { __typename: "Commit", oid: "new-commit" } } },
    },
    { description: "an unavailable source repository", head: {}, source: null },
  ])("refuses to delete $description", ({ head, source }) =>
    Effect.gen(function* () {
      route(
        ["PullRequestBranchToDelete", branchToDelete(head)],
        [
          "PullRequestSourceBranch",
          source === null ? { data: { node: null } } : sourceBranch(source),
        ],
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const error = yield* Effect.flip(
        cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "delete-branch",
        }),
      );
      expect(error._tag).toBe("GitHubBranchDeletionRefusedError");
      expect(variablesOf("updateRefs(")).toEqual([]);
    }),
  );

  it.effect("accepts an already deleted source branch", () =>
    Effect.gen(function* () {
      route(
        ["PullRequestBranchToDelete", branchToDelete()],
        ["PullRequestSourceBranch", sourceBranch({ ref: null })],
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "delete-branch",
      });
      expect(variablesOf("updateRefs(")).toEqual([]);
    }),
  );

  it.effect("keeps the source branch when GitHub refuses deletion", () =>
    Effect.gen(function* () {
      route(
        ["PullRequestBranchToDelete", branchToDelete()],
        ["PullRequestSourceBranch", sourceBranch()],
      );
      const answer = mockedExecute.getMockImplementation()!;
      mockedExecute.mockImplementation((call) =>
        call.kind === "graphql" && matches(call, "updateRefs(")
          ? Effect.fail(
              new GitHubRequestPolicy.GitHubApiResponseError({
                host: call.host,
                operation: call.operation,
                status: 422,
              }),
            )
          : answer(call),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const error = yield* Effect.flip(
        cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "delete-branch",
        }),
      );
      expect(error._tag).toBe("GitHubApiResponseError");
      expect(variablesOf("mergePullRequest(")).toEqual([]);
      expect(variablesOf("closePullRequest(")).toEqual([]);
    }),
  );

  it.effect.each(["merge", "enable-auto-merge"] as const)(
    "removes agent credits from the proposed message for %s",
    (action) =>
      Effect.gen(function* () {
        route(
          [
            "query PullRequestMergeMessage",
            mergeMessage(
              "Details\n\nCo-authored-by: Alice <alice@example.com>\nCo-authored-by: Claude <noreply@anthropic.com>",
            ),
          ],
          ["query PullRequestActionState", actionState()],
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        yield* cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action,
          mergeMethod: "squash",
          removeAgentCreditsOnMerge: true,
        });
        expect(variablesOf("query PullRequestMergeMessage")[0]?.["method"]).toBe("SQUASH");
        expect(
          variablesOf(action === "merge" ? "mergePullRequest(" : "enablePullRequestAutoMerge("),
        ).toEqual([
          {
            input: {
              pullRequestId: "PR_7",
              mergeMethod: "SQUASH",
              expectedHeadOid: "abc123",
              commitBody: "Details\n\nCo-authored-by: Alice <alice@example.com>",
            },
          },
        ]);
      }),
  );

  it.effect.each([
    {
      description: "an unchanged message",
      body: "Details\n\nCo-authored-by: Alice <alice@example.com>",
      queued: false,
    },
    {
      description: "a merge queue",
      body: "Co-authored-by: Claude <noreply@anthropic.com>",
      queued: true,
    },
  ] as const)("keeps GitHub's default message for $description", ({ body, queued }) =>
    Effect.gen(function* () {
      route(
        ["query PullRequestMergeMessage", mergeMessage(body, queued)],
        ["query PullRequestActionState", actionState({ isMergeQueueEnabled: queued })],
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "merge",
        removeAgentCreditsOnMerge: true,
      });
      expect(variablesOf("query PullRequestMergeMessage")[0]?.["method"]).toBe("MERGE");
      expect(variablesOf(queued ? "enablePullRequestAutoMerge(" : "mergePullRequest(")).toEqual([
        { input: { pullRequestId: "PR_7", mergeMethod: "MERGE" } },
      ]);
    }),
  );

  it.effect("passes an explicitly empty body when the proposed message only credits an agent", () =>
    Effect.gen(function* () {
      route(
        [
          "query PullRequestMergeMessage",
          mergeMessage("Co-authored-by: Claude <noreply@anthropic.com>"),
        ],
        ["query PullRequestActionState", actionState()],
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "merge",
        removeAgentCreditsOnMerge: true,
      });
      expect(variablesOf("mergePullRequest(")).toEqual([
        {
          input: {
            pullRequestId: "PR_7",
            mergeMethod: "MERGE",
            expectedHeadOid: "abc123",
            commitBody: "",
          },
        },
      ]);
    }),
  );

  it.effect("keeps the caller's expected head as the only pin on a cleaned merge", () =>
    Effect.gen(function* () {
      route(
        [
          "query PullRequestMergeMessage",
          {
            data: {
              repository: {
                pullRequest: {
                  isMergeQueueEnabled: false,
                  headRefOid: "def456",
                  viewerMergeBodyText: "Co-authored-by: Claude <noreply@anthropic.com>",
                },
              },
            },
          },
        ],
        ["query PullRequestActionState", actionState()],
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "merge",
        mergeMethod: "squash",
        expectedHeadSha: "abc123",
        removeAgentCreditsOnMerge: true,
      });
      expect(variablesOf("mergePullRequest(")).toEqual([
        {
          input: {
            pullRequestId: "PR_7",
            mergeMethod: "SQUASH",
            expectedHeadOid: "abc123",
            commitBody: "",
          },
        },
      ]);
    }),
  );

  it.effect("does not fetch a message for rebase merges", () =>
    Effect.gen(function* () {
      route(["query PullRequestActionState", actionState()]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "merge",
        mergeMethod: "rebase",
        removeAgentCreditsOnMerge: true,
      });
      expect(variablesOf("query PullRequestMergeMessage")).toEqual([]);
      expect(variablesOf("mergePullRequest(")).toEqual([
        { input: { pullRequestId: "PR_7", mergeMethod: "REBASE" } },
      ]);
    }),
  );

  it.effect("refuses to merge when the proposed message cannot be read", () =>
    Effect.gen(function* () {
      route(
        ["query PullRequestMergeMessage", { data: { repository: { pullRequest: null } } }],
        ["query PullRequestActionState", actionState()],
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const result = yield* Effect.result(
        cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "merge",
          removeAgentCreditsOnMerge: true,
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(variablesOf("mergePullRequest(")).toEqual([]);
    }),
  );

  it.effect("arms auto-merge with the same strategy a merge would have used", () =>
    Effect.gen(function* () {
      route(["query PullRequestActionState", actionState()]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "enable-auto-merge",
        mergeMethod: "squash",
      });
      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "enable-auto-merge",
      });

      expect(variablesOf("enablePullRequestAutoMerge(")).toEqual([
        { input: { pullRequestId: "PR_7", mergeMethod: "SQUASH" } },
        { input: { pullRequestId: "PR_7", mergeMethod: "MERGE" } },
      ]);
      expect(variablesOf("mergePullRequest(")).toEqual([]);
    }),
  );

  it.effect("merges at once when auto-merge is asked of a pull request that is ready now", () =>
    Effect.gen(function* () {
      route(["query PullRequestActionState", actionState({ mergeStateStatus: "CLEAN" })]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "enable-auto-merge",
        mergeMethod: "squash",
      });

      expect(variablesOf("mergePullRequest(")).toEqual([
        { input: { pullRequestId: "PR_7", mergeMethod: "SQUASH" } },
      ]);
      expect(variablesOf("enablePullRequestAutoMerge(")).toEqual([]);
    }),
  );

  it.effect("pins a merge and an armed auto-merge to the head the reader saw", () =>
    Effect.gen(function* () {
      const expectedHeadSha = "0962ce611d58a27a0baa269cc60804dbd5242a78";
      route(["query PullRequestActionState", actionState({ headRefOid: expectedHeadSha })]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      for (const action of ["merge", "enable-auto-merge"] as const) {
        yield* cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action,
          mergeMethod: "squash",
          expectedHeadSha,
        });
      }

      const pinned = {
        pullRequestId: "PR_7",
        mergeMethod: "SQUASH",
        expectedHeadOid: expectedHeadSha,
      };
      expect(variablesOf("mergePullRequest(")).toEqual([{ input: pinned }]);
      expect(variablesOf("enablePullRequestAutoMerge(")).toEqual([{ input: pinned }]);
    }),
  );

  it.effect("says the head moved when a pinned merge is refused for that reason", () =>
    Effect.gen(function* () {
      const refused = new GitHubRequestPolicy.GitHubApiResponseError({
        host: "github.com",
        operation: "runPullRequestAction",
        status: 200,
        githubErrors: ["Head branch was modified. Review and try the merge again."],
      });
      /** Answers the action state with each head in turn, and fails the merge mutation. */
      const answer = (...heads: ReadonlyArray<string>) => {
        let reads = 0;
        mockedExecute.mockImplementation((call) => {
          if (call.kind === "graphql" && matches(call, "mergePullRequest(")) {
            return Effect.fail(refused);
          }
          const headRefOid = heads[Math.min(reads++, heads.length - 1)];
          return Effect.succeed(output(encodeJson(actionState({ headRefOid }))));
        });
      };
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const merge = () =>
        cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "merge",
          mergeMethod: "squash",
          expectedHeadSha: "abc123",
        });

      // Already moved when the merge reads the pull request: nothing is sent.
      answer("def456");
      const early = yield* Effect.flip(merge());
      expect(early).toMatchObject({ _tag: "GitHubMergeHeadChangedError", number: 7 });
      expect(early.message).toContain("New commits were pushed to #7");
      expect(variablesOf("mergePullRequest(")).toEqual([]);

      // Moved between that read and the merge: GitHub refuses, and a second read says why.
      mockedExecute.mockClear();
      answer("abc123", "def456");
      expect(yield* Effect.flip(merge())).toMatchObject({
        _tag: "GitHubMergeHeadChangedError",
        number: 7,
      });

      // Refused for some other reason while the head stayed put: the original failure stands.
      answer("abc123");
      expect(yield* Effect.flip(merge())).toMatchObject({
        _tag: refused._tag,
        status: refused.status,
      });
    }),
  );

  it.effect("takes auto-merge back off without naming a strategy", () =>
    Effect.gen(function* () {
      route([NODE_ID_QUERY, nodeIdAnswer("PR_7")]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "disable-auto-merge",
        mergeMethod: "squash",
      });

      expect(variablesOf("disablePullRequestAutoMerge(")).toEqual([{ pullRequestId: "PR_7" }]);
    }),
  );

  it.effect("opens a pull request that reverts a merged pull request", () =>
    Effect.gen(function* () {
      route([NODE_ID_QUERY, nodeIdAnswer("PR_7")]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "revert",
      });

      expect(variablesOf("revertPullRequest(")).toEqual([{ pullRequestId: "PR_7" }]);
    }),
  );

  it.effect(
    "starts runs a workflow's own push left waiting on a same-repository pull request",
    () =>
      Effect.gen(function* () {
        const sameRepositoryDetail = () =>
          coreResponse({
            headRefName: "changeset-release/main",
            headRefOid: "abc123",
            isCrossRepository: false,
            headRepositoryOwner: { __typename: "Organization", login: "acme" },
          });
        mockedExecute.mockImplementation((call) =>
          call.kind === "rest" && call.path.endsWith("/10/approve")
            ? Effect.fail(
                new GitHubRequestPolicy.GitHubApiResponseError({
                  host: "github.com",
                  operation: "approveWorkflowRun",
                  status: 403,
                }),
              )
            : Effect.sync(() =>
                output(
                  call.kind === "rest"
                    ? ""
                    : matches(call, CHECK_SUITES_QUERY)
                      ? encodeJson(workflowRuns([10, 11], "changeset-release/main"))
                      : encodeJson(sameRepositoryDetail()),
                ),
              ),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

        yield* cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "approve-workflows",
        });

        // The repository's own branch needs no check that the head names this pull request alone.
        expect(variablesOf("headRefName: $head")).toEqual([]);
        // GitHub refused to approve run 10 as a fork run, so it was started as a new attempt.
        expect(
          restCallsTo("actions/runs/")
            .filter((call) => call.method === "POST")
            .map((call) => call.path),
        ).toEqual([
          "repos/acme/web/actions/runs/10/approve",
          "repos/acme/web/actions/runs/10/rerun",
          "repos/acme/web/actions/runs/11/approve",
        ]);
      }),
  );

  it.effect("reads the deployments a waiting run holds for the viewer, and reviews them", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.sync(() =>
          output(
            call.kind !== "rest"
              ? ""
              : call.path.endsWith("/pending_deployments") && call.method !== "POST"
                ? encodeJson([
                    {
                      environment: { id: 21, name: "production" },
                      current_user_can_approve: true,
                    },
                    {
                      environment: { id: 22, name: "staging" },
                      current_user_can_approve: false,
                    },
                  ])
                : call.method === "POST"
                  ? "[]"
                  : encodeJson({
                      name: "Promote",
                      run_number: 3,
                      status: "waiting",
                      conclusion: null,
                      html_url: "https://github.com/acme/web/actions/runs/40",
                      head_branch: "main",
                      head_sha: "abc123",
                      event: "workflow_run",
                    }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const target = { cwd: "/w", repository: "acme/web", host: "github.com", runId: 40 };

      const run = yield* cli.getWorkflowRun(target);
      expect(run.completed).toBe(false);
      // An environment the viewer may not approve is someone else's to review.
      expect(run.reviewableEnvironments).toEqual([{ id: 21, name: "production" }]);

      yield* cli.reviewWorkflowRun({
        ...target,
        environmentIds: [21],
        state: "approved",
        comment: "Ship it",
      });
      expect(
        restCallsTo("actions/runs/40/pending_deployments")
          .filter((call) => call.method === "POST")
          .map((call) => call.body),
      ).toEqual([{ environment_ids: [21], state: "approved", comment: "Ship it" }]);
    }),
  );

  it.effect("revalidates run and deployment state independently, and refreshes after review", () =>
    Effect.gen(function* () {
      const unchanged = output("", false, false, {}, 304);
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(output(encodeJson(waitingWorkflow), false, false, { etag: 'W/"run"' })),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(encodeJson(pendingDeployment(true)), false, false, { etag: '"p1"' }),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(unchanged))
        .mockReturnValueOnce(
          Effect.succeed(
            output(encodeJson(pendingDeployment(false)), false, false, { etag: '"p2"' }),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(unchanged))
        .mockReturnValueOnce(Effect.succeed(unchanged))
        .mockReturnValueOnce(Effect.succeed(output("[]")))
        .mockReturnValueOnce(
          Effect.succeed(output(encodeJson(waitingWorkflow), false, false, { etag: 'W/"run"' })),
        )
        .mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      expect((yield* cli.getWorkflowRun(workflowTarget)).reviewableEnvironments).toEqual([
        { id: 21, name: "production" },
      ]);
      const changed = yield* cli.getWorkflowRun(workflowTarget);
      expect(changed.reviewableEnvironments).toEqual([]);
      expect(changed.completed).toBe(false);
      expect(yield* cli.getWorkflowRun(workflowTarget)).toEqual(changed);
      yield* cli.reviewWorkflowRun({
        ...workflowTarget,
        environmentIds: [21],
        state: "approved",
        comment: "Synthetic review",
      });
      expect((yield* cli.getWorkflowRun(workflowTarget)).reviewableEnvironments).toEqual([]);
      expect(
        restCallsTo(workflowEndpoint).map(({ path, method, ifNoneMatch }) => [
          path.slice(workflowEndpoint.length),
          method ?? "GET",
          ifNoneMatch,
        ]),
      ).toEqual([
        ["", "GET", undefined],
        ["/pending_deployments", "GET", undefined],
        ["", "GET", 'W/"run"'],
        ["/pending_deployments", "GET", '"p1"'],
        ["", "GET", 'W/"run"'],
        ["/pending_deployments", "GET", '"p2"'],
        ["/pending_deployments", "POST", undefined],
        ["", "GET", undefined],
        ["/pending_deployments", "GET", undefined],
      ]);
    }),
  );

  it.effect(
    "isolates workflow validators by credential, host, repository and run, pinning each read",
    () =>
      Effect.gen(function* () {
        let active = "first";
        mockedCredential.mockImplementation(() =>
          Effect.succeed({ token: Redacted.make(active), fingerprint: active }),
        );
        const credentials: string[] = [];
        mockedExecute.mockImplementation((call) =>
          Effect.gen(function* () {
            const pinned = yield* GitHubRequestPolicy.PinnedGitHubCredential;
            assert(pinned !== null);
            credentials.push(pinned.credentialFingerprint);
            expect(yield* SourceControlRateLimit.CredentialScope).toBe(
              pinned.credentialFingerprint,
            );
            // An account switch between the run and deployment reads cannot change this read's token.
            active = "second";
            return call.kind === "rest" && call.ifNoneMatch
              ? output("", false, false, {}, 304)
              : output(
                  encodeJson(
                    call.kind === "rest" && call.path.endsWith("/pending_deployments")
                      ? pendingDeployment(pinned.credentialFingerprint === "first")
                      : waitingWorkflow,
                  ),
                  false,
                  false,
                  { etag: '"one"' },
                );
          }),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        expect((yield* cli.getWorkflowRun(workflowTarget)).reviewableEnvironments).toHaveLength(1);
        expect((yield* cli.getWorkflowRun(workflowTarget)).reviewableEnvironments).toEqual([]);
        for (const target of [
          { ...workflowTarget, host: "github.example" },
          { ...workflowTarget, repository: "acme/other" },
          { ...workflowTarget, runId: 41 },
        ])
          yield* cli.getWorkflowRun(target);
        expect(restCallsTo("actions/runs/").every((call) => call.ifNoneMatch === undefined)).toBe(
          true,
        );
        active = "first";
        expect((yield* cli.getWorkflowRun(workflowTarget)).reviewableEnvironments).toHaveLength(1);
        expect(credentials).toEqual([
          "first",
          "first",
          "second",
          "second",
          "second",
          "second",
          "second",
          "second",
          "second",
          "second",
          "first",
          "first",
        ]);
        expect(
          restCallsTo(workflowEndpoint)
            .slice(-2)
            .map((call) => call.ifNoneMatch),
        ).toEqual(['"one"', '"one"']);
      }),
  );

  it.effect("serializes concurrent workflow reads and expires inactive validators", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const target = { ...workflowTarget, runId: 42 };
      mockedExecute.mockImplementation((call) =>
        Effect.yieldNow.pipe(
          Effect.as(
            call.kind === "rest" && call.ifNoneMatch
              ? output("", false, false, {}, 304)
              : output(encodeJson({ ...waitingWorkflow, status: "in_progress" }), false, false, {
                  etag: '"one"',
                }),
          ),
        ),
      );
      const runs = yield* Effect.all(
        Array.from({ length: 4 }, () => cli.getWorkflowRun(target)),
        {
          concurrency: 4,
        },
      );
      expect(runs.every((run) => !run.completed)).toBe(true);
      expect(restCallsTo("actions/runs/42").map((call) => call.ifNoneMatch)).toEqual([
        undefined,
        '"one"',
        '"one"',
        '"one"',
      ]);
      yield* TestClock.adjust("31 minutes");
      yield* cli.getWorkflowRun(target);
      expect(restCallsTo("actions/runs/42").at(-1)?.ifNoneMatch).toBeUndefined();
    }),
  );

  it.effect("uses unconditional workflow reads when ETags are absent, ignored or removed", () =>
    Effect.gen(function* () {
      for (const headers of [{}, { etag: '"one"' }, {}, {}, { etag: " " }, {}]) {
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(
            output(
              encodeJson({ ...waitingWorkflow, status: "in_progress" }),
              false,
              false,
              headers,
            ),
          ),
        );
      }
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      for (let read = 0; read < 6; read++) yield* cli.getWorkflowRun(workflowTarget);
      expect(restCallsTo(workflowEndpoint).map((call) => call.ifNoneMatch)).toEqual([
        undefined,
        undefined,
        '"one"',
        undefined,
        undefined,
        undefined,
      ]);
    }),
  );

  it.effect.each(
    (
      [
        ["truncated", output(encodeJson(waitingWorkflow), true, false, { etag: '"bad"' })],
        ["invalid UTF-8", output(encodeJson(waitingWorkflow), false, true, { etag: '"bad"' })],
        ["invalid JSON", output("{", false, false, { etag: '"bad"' })],
        ["invalid fields", output("{}", false, false, { etag: '"bad"' })],
        [
          "unexpected status",
          output(encodeJson(waitingWorkflow), false, false, { etag: '"bad"' }, 202),
        ],
      ] as const
    ).map(([label, response]) => ({ label, response })),
  )("does not retain $label workflow responses or the validator they replaced", ({ response }) =>
    Effect.gen(function* () {
      const good = output(encodeJson({ ...waitingWorkflow, status: "in_progress" }), false, false, {
        etag: '"good"',
      });
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(good))
        .mockReturnValueOnce(Effect.succeed(response))
        .mockReturnValueOnce(Effect.succeed(good));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      yield* cli.getWorkflowRun(workflowTarget);
      expect((yield* cli.getWorkflowRun(workflowTarget).pipe(Effect.flip))._tag).toBe(
        "GitHubPullRequestReadError",
      );
      yield* cli.getWorkflowRun(workflowTarget);
      expect(restCallsTo(workflowEndpoint).map((call) => call.ifNoneMatch)).toEqual([
        undefined,
        '"good"',
        undefined,
      ]);
    }),
  );

  it.effect(
    "rejects unsolicited 304s and truncated deployment bodies before caching their validators",
    () =>
      Effect.gen(function* () {
        const run = output(encodeJson(waitingWorkflow), false, false, { etag: '"run"' });
        mockedExecute
          .mockReturnValueOnce(Effect.succeed(output("", false, false, {}, 304)))
          .mockReturnValueOnce(Effect.succeed(run))
          .mockReturnValueOnce(Effect.succeed(output("[]", true, false, { etag: '"pending"' })))
          .mockReturnValueOnce(Effect.succeed(output("", false, false, {}, 304)))
          .mockReturnValueOnce(Effect.succeed(output(encodeJson(pendingDeployment(true)))));
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        for (let read = 0; read < 2; read++) {
          expect((yield* cli.getWorkflowRun(workflowTarget).pipe(Effect.flip))._tag).toBe(
            "GitHubPullRequestReadError",
          );
        }
        expect((yield* cli.getWorkflowRun(workflowTarget)).reviewableEnvironments).toEqual([
          { id: 21, name: "production" },
        ]);
        expect(restCallsTo(workflowEndpoint).map((call) => call.ifNoneMatch)).toEqual([
          undefined,
          undefined,
          undefined,
          '"run"',
          undefined,
        ]);
      }),
  );

  it.effect(
    "propagates failed deployment reads and discards their validator without losing the run",
    () =>
      Effect.gen(function* () {
        const failure = new GitHubRequestPolicy.GitHubApiResponseError({
          host: workflowTarget.host,
          operation: "getWorkflowRun",
          status: 502,
        });
        mockedExecute
          .mockReturnValueOnce(
            Effect.succeed(output(encodeJson(waitingWorkflow), false, false, { etag: '"run"' })),
          )
          .mockReturnValueOnce(
            Effect.succeed(
              output(encodeJson(pendingDeployment(true)), false, false, { etag: '"pending"' }),
            ),
          )
          .mockReturnValueOnce(Effect.succeed(output("", false, false, {}, 304)))
          .mockReturnValueOnce(Effect.fail(failure))
          .mockReturnValueOnce(Effect.succeed(output("", false, false, {}, 304)))
          .mockReturnValueOnce(Effect.succeed(output("[]")));
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        yield* cli.getWorkflowRun(workflowTarget);
        expect(yield* cli.getWorkflowRun(workflowTarget).pipe(Effect.flip)).toBe(failure);
        expect((yield* cli.getWorkflowRun(workflowTarget)).reviewableEnvironments).toEqual([]);
        expect(restCallsTo(workflowEndpoint).map((call) => call.ifNoneMatch)).toEqual([
          undefined,
          undefined,
          '"run"',
          '"pending"',
          '"run"',
          undefined,
        ]);
      }),
  );

  it.effect(
    "refreshes the latest attempt's failed jobs even when the completed run returns 304",
    () =>
      Effect.gen(function* () {
        const completed = { ...waitingWorkflow, status: "completed", conclusion: "failure" };
        const jobs = (name: string) => ({
          jobs: [
            {
              name,
              conclusion: "failure",
              html_url: "https://github.com/acme/web/actions/runs/40",
            },
            { name: "Passing", conclusion: "success", html_url: null },
            { name: "Skipped", conclusion: "skipped", html_url: null },
          ],
        });
        mockedExecute
          .mockReturnValueOnce(
            Effect.succeed(output(encodeJson(completed), false, false, { etag: '"run"' })),
          )
          .mockReturnValueOnce(
            Effect.succeed(
              output(encodeJson(jobs("First attempt")), false, false, { etag: '"jobs"' }),
            ),
          )
          .mockReturnValueOnce(Effect.succeed(output("", false, false, {}, 304)))
          .mockReturnValueOnce(Effect.succeed(output(encodeJson(jobs("Latest attempt")))))
          .mockReturnValueOnce(
            Effect.succeed(
              output(encodeJson({ ...waitingWorkflow, status: "in_progress", run_attempt: 2 })),
            ),
          );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        expect(
          (yield* cli.getWorkflowRun(workflowTarget)).failedJobs.map((job) => job.name),
        ).toEqual(["First attempt"]);
        const latest = yield* cli.getWorkflowRun(workflowTarget);
        expect(latest.completed).toBe(true);
        expect(latest.conclusion).toBe("failure");
        expect(latest.failedJobs.map((job) => job.name)).toEqual(["Latest attempt"]);
        expect(restCallsTo("/jobs").map(({ path, ifNoneMatch }) => [path, ifNoneMatch])).toEqual([
          [`${workflowEndpoint}/jobs?filter=latest&per_page=100`, undefined],
          [`${workflowEndpoint}/jobs?filter=latest&per_page=100`, undefined],
        ]);
        const rerun = yield* cli.getWorkflowRun(workflowTarget);
        expect(rerun.completed).toBe(false);
        expect(rerun.conclusion).toBeNull();
        expect(rerun.failedJobs).toEqual([]);
      }),
  );

  it.effect("finds and approves every workflow waiting on a maintainer", () =>
    Effect.gen(function* () {
      workflowApprovalRoutes(() => crossRepositoryDetail(), heads([7]), workflowRuns([10, 11]));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "approve-workflows",
      });

      // Open pull requests on this head branch, and runs scoped to this exact head.
      // The first page sends no cursor at all, which reads from the start.
      expect(variablesOf("PullRequestHeads")[0]).toEqual({
        owner: "acme",
        name: "web",
        head: "feat/page",
      });
      expect(variablesOf(CHECK_SUITES_QUERY)[0]).toEqual({
        owner: "acme",
        name: "web",
        oid: "abc123",
      });
      expect(restCallsTo("/approve").map((call) => [call.method, call.path])).toEqual([
        ["POST", "repos/acme/web/actions/runs/10/approve"],
        ["POST", "repos/acme/web/actions/runs/11/approve"],
      ]);
      assert.strictEqual(variablesOf(CHECK_SUITES_QUERY).length, 3);
    }),
  );

  it.effect("refuses a stale workflow approval after the pull request head changes", () =>
    Effect.gen(function* () {
      let detailReads = 0;
      workflowApprovalRoutes(
        () => crossRepositoryDetail(++detailReads === 1 ? "abc123" : "def456"),
        heads([7]),
        workflowRuns([10]),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "approve-workflows",
        }),
      );

      expect(error).toMatchObject({
        _tag: "GitHubWorkflowApprovalHeadChangedError",
        number: 7,
      });
      assert.strictEqual(detailReads, 2);
      expect(restCallsTo("/approve")).toEqual([]);
    }),
  );

  it.effect("reads workflow runs and their pull request scope concurrently", () =>
    Effect.gen(function* () {
      const headsStarted = yield* Deferred.make<void>();
      const runsStarted = yield* Deferred.make<void>();
      mockedExecute.mockImplementation((call) =>
        call.kind === "graphql" && matches(call, "headRefName: $head")
          ? Deferred.succeed(headsStarted, undefined).pipe(
              Effect.andThen(Deferred.await(runsStarted)),
              Effect.as(output(encodeJson(heads([7])))),
            )
          : Deferred.succeed(runsStarted, undefined).pipe(
              Effect.andThen(Deferred.await(headsStarted)),
              Effect.as(output(encodeJson(workflowRuns([10])))),
            ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const runs = yield* cli.listWorkflowRunsRequiringApproval({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        headSha: "abc123",
        headBranch: "feat/page",
        headRepositoryOwner: "octocat",
        isCrossRepository: true,
      });

      expect(runs).toEqual([{ id: 10, name: "build", url: "https://example.com/10" }]);
    }),
  );

  it.effect("refuses workflow approval when one head belongs to several pull requests", () =>
    Effect.gen(function* () {
      workflowApprovalRoutes(() => crossRepositoryDetail(), heads([7, 8]), workflowRuns([]));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.listWorkflowRunsRequiringApproval({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          headSha: "abc123",
          headBranch: "feat/page",
          headRepositoryOwner: "octocat",
          isCrossRepository: true,
        }),
      );

      expect(error).toMatchObject({
        _tag: "GitHubWorkflowApprovalRefusedError",
        reason: "head-not-unique",
        number: 7,
        observedCount: 2,
        limit: 1_000,
      });
      expect(error.message).toContain("instead of uniquely matching #7");
    }),
  );

  it.effect("refuses workflow approval when the head list stops before its end", () =>
    Effect.gen(function* () {
      const repeating = heads([7]);
      repeating.data.repository.pullRequests.pageInfo = {
        hasNextPage: true,
        endCursor: "same",
      } as never;
      workflowApprovalRoutes(() => crossRepositoryDetail(), repeating, workflowRuns([]));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.listWorkflowRunsRequiringApproval({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          headSha: "abc123",
          headBranch: "feat/page",
          headRepositoryOwner: "octocat",
          isCrossRepository: true,
        }),
      );

      expect(error).toMatchObject({
        _tag: "GitHubWorkflowApprovalRefusedError",
        reason: "head-list-truncated",
      });
    }),
  );

  it.effect("refuses workflow approval when GitHub omits the head repository", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson(
              coreResponse({
                number: 7,
                title: "Pull request 7",
                url: "https://github.com/acme/web/pull/7",
                headRefName: "feat/page",
                headRefOid: "abc123",
                isCrossRepository: true,
                headRepositoryOwner: null,
                baseRefName: "main",
                createdAt: "2026-07-01T00:00:00Z",
                updatedAt: "2026-07-02T00:00:00Z",
              }),
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "approve-workflows",
        }),
      );

      expect(error).toMatchObject({
        _tag: "GitHubWorkflowApprovalHeadUnavailableError",
        number: 7,
      });
      expect(mockedExecute).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("surfaces a workflow run list beyond the safe approval bound", () =>
    Effect.gen(function* () {
      let runPages = 0;
      mockedExecute.mockImplementation((call) => {
        if (call.kind === "graphql" && matches(call, "headRefName: $head")) {
          return Effect.succeed(output(encodeJson(heads([7]))));
        }
        const page = runPages++;
        return Effect.succeed(
          output(
            encodeJson(
              workflowRuns(
                Array.from({ length: 100 }, (_, index) => page * 100 + index + 1),
                "feat/page",
                `page-${page + 1}`,
              ),
            ),
          ),
        );
      });
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.listWorkflowRunsRequiringApproval({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          headSha: "abc123",
          headBranch: "feat/page",
          headRepositoryOwner: "octocat",
          isCrossRepository: true,
        }),
      );

      expect(error).toMatchObject({
        _tag: "GitHubWorkflowApprovalRefusedError",
        reason: "run-list-truncated",
        number: 7,
        observedCount: 1_100,
        limit: 1_000,
      });
      expect(error.message).toContain("more than 1000 workflow runs");
      assert.strictEqual(runPages, 11);
    }),
  );

  it.effect("returns a pull request to draft by converting it", () =>
    Effect.gen(function* () {
      route([NODE_ID_QUERY, nodeIdAnswer("PR_7")]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "draft",
      });

      expect(variablesOf("convertPullRequestToDraft(")).toEqual([{ pullRequestId: "PR_7" }]);
      expect(variablesOf("markPullRequestReadyForReview(")).toEqual([]);
    }),
  );

  it.effect("sends a comment body as a variable, never inside the document", () =>
    Effect.gen(function* () {
      route([NODE_ID_QUERY, nodeIdAnswer("PR_7")]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.commentOnPullRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        body: "Looks good.",
      });

      expect(variablesOf("addComment(")).toEqual([{ subjectId: "PR_7", body: "Looks good." }]);
      expect(queryAt(mockedExecute.mock.calls.length - 1)).not.toContain("Looks good.");
    }),
  );

  it.effect("names the host on every repository it addresses", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.operationName?.startsWith("PullRequestList")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.isAbove(mockedExecute.mock.calls.length, 0);
      expect(new Set(mockedExecute.mock.calls.map(([call]) => call.host))).toEqual(
        new Set(["github.acme.dev"]),
      );
      expect(searchOfCall(0)).toContain("repo:acme/web");
    }),
  );

  it.effect("asks a GitHub Enterprise host for its own review threads", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(reviewThreadsPage([], null))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        number: 7,
      });

      expect(callAt(0).host).toBe("github.acme.dev");
      expect(varsAt(0)).toMatchObject({ owner: "acme", name: "web", number: 7 });
    }),
  );

  it.effect("serves a diff GitHub hands over whole in one request, with no next slice", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("diff --git a/a b/a")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.strictEqual(diff.patch, "diff --git a/a b/a");
      assert.isNull(diff.nextCursor);
      assert.isFalse(diff.truncated);
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      const call = callAt(0);
      assert.strictEqual(call.kind, "rest");
      if (call.kind === "rest") {
        assert.strictEqual(call.path, "repos/acme/web/pulls/7");
        assert.strictEqual(call.accept, "application/vnd.github.diff");
      }
    }),
  );

  it.effect("reads one files page when GitHub refuses the diff, and says it is the last", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(2, 1))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        number: 7,
      });

      assert.isFalse(diff.truncated);
      assert.isNull(diff.nextCursor);
      expect(diff.patch).toContain("diff --git a/src/file1.ts b/src/file1.ts");
      expect(diff.patch).toContain("diff --git a/src/file2.ts b/src/file2.ts");
      assert.strictEqual(callAt(1).host, "github.acme.dev");
      assert.strictEqual(pathAt(1), "repos/acme/web/pulls/7/files?per_page=100&page=1");
    }),
  );

  it.effect("hands back a cursor for the next page rather than walking on by itself", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(100, 0))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.isFalse(diff.truncated);
      assert.isNotNull(diff.nextCursor);
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect("carries on from a cursor without asking for the whole diff again", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(100, 0))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const target = { cwd: "/w", repository: "acme/web", host: "github.com", number: 7 };

      const first = yield* cli.getPullRequestDiff(target);
      assert.isNotNull(first.nextCursor);
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(4, 100))));
      const second = yield* cli.getPullRequestDiff({ ...target, cursor: first.nextCursor });

      assert.isNull(second.nextCursor);
      expect(second.patch).toContain("diff --git a/src/file100.ts b/src/file100.ts");
      assert.strictEqual(mockedExecute.mock.calls.length, 3);
      assert.strictEqual(pathAt(2), "repos/acme/web/pulls/7/files?per_page=100&page=2");
    }),
  );

  it.effect("refuses a cursor it never handed out rather than reading it into a request", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          cursor: "1&per_page=1",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffCursorError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("reads a named commit from the commit endpoint rather than the whole diff", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(`{"files":${pullRequestFiles(2, 1)}}`)),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        commit: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      assert.isNull(diff.nextCursor);
      expect(diff.patch).toContain("diff --git a/src/file1.ts b/src/file1.ts");
      assert.strictEqual(
        pathAt(0),
        "repos/acme/web/commits/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0?per_page=100&page=1",
      );
    }),
  );

  it.effect("pages inside a commit the way it pages the pull request's own files", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(`{"files":${pullRequestFiles(100, 0)}}`)),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const target = {
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        commit: "a1b2c3d",
      };

      const first = yield* cli.getPullRequestDiff(target);
      assert.isNotNull(first.nextCursor);
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(`{"files":${pullRequestFiles(4, 100)}}`)),
      );
      const second = yield* cli.getPullRequestDiff({ ...target, cursor: first.nextCursor });

      assert.isNull(second.nextCursor);
      expect(second.patch).toContain("src/file100.ts");
      assert.strictEqual(pathAt(1), "repos/acme/web/commits/a1b2c3d?per_page=100&page=2");
    }),
  );

  it.effect("refuses a commit that is not a sha rather than reading it into a request", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          commit: "../../pulls/8/files",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffCommitError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("expands a new file from a root commit without requiring a parent", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(encodeJson({ sha: "a1b2c3d", parents: [] }))),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("root contents\n")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const contents = yield* cli.getPullRequestDiffFileContents({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        commit: "a1b2c3d",
        changeType: "new",
        oldPath: "src/root.ts",
        newPath: "src/root.ts",
      });

      expect(contents).toEqual({ oldContents: "", newContents: "root contents\n" });
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      assert.strictEqual(pathAt(0), "repos/acme/web/commits/a1b2c3d");
      assert.strictEqual(pathAt(1), "repos/acme/web/contents/src/root.ts?ref=a1b2c3d");
    }),
  );

  it.effect("reports unusable diff revisions as a structured error", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("not-a-sha\tstill-not-a-sha\n")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDiffFileContents({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          commit: "a1b2c3d",
          changeType: "change",
          oldPath: "src/a.ts",
          newPath: "src/a.ts",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffRevisionsUnavailableError");
      if (error._tag === "GitHubDiffRevisionsUnavailableError") {
        assert.strictEqual(error.number, 7);
        assert.strictEqual(error.commit, "a1b2c3d");
      }
    }),
  );

  it.effect("reports an oversized diff file with its path and reason", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestRefs)));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("partial", true)));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDiffFileContents({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          changeType: "deleted",
          oldPath: "src/large.ts",
          newPath: "src/large.ts",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffFileContentsUnavailableError");
      if (error._tag === "GitHubDiffFileContentsUnavailableError") {
        assert.strictEqual(error.path, "src/large.ts");
        assert.strictEqual(error.reason, "oversized");
      }
      assert.strictEqual(pathAt(1), "repos/acme/web/contents/src/large.ts?ref=a1b2c3d");
    }),
  );

  it.effect("reports undecodable diff file contents as binary", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestRefs)));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("binary�contents", false, true)));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDiffFileContents({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          changeType: "deleted",
          oldPath: "assets/logo.png",
          newPath: "assets/logo.png",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffFileContentsUnavailableError");
      if (error._tag === "GitHubDiffFileContentsUnavailableError") {
        assert.strictEqual(error.path, "assets/logo.png");
        assert.strictEqual(error.reason, "binary");
      }
    }),
  );

  it.effect("returns valid text containing a literal replacement character", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestRefs)));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("before�after")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const contents = yield* cli.getPullRequestDiffFileContents({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        changeType: "deleted",
        oldPath: "docs/encoding.md",
        newPath: "docs/encoding.md",
      });

      assert.strictEqual(contents.oldContents, "before�after");
    }),
  );

  it.effect("issues a browser-readable URL for a file at the pull request head", () =>
    Effect.gen(function* () {
      const url =
        "https://raw.githubusercontent.com/acme/web/refs/pull/7/head/docs/screenshot.png?token=file-token";
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(encodeJson({ type: "file", download_url: url, size: 83785, content: "iVBORw0K" })),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      expect(
        yield* cli.getPullRequestFile({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          path: "docs/screenshots/hello world.png",
        }),
      ).toEqual({ url, size: 83_785 });

      expect(pathAt(0)).toBe(
        "repos/acme/web/contents/docs/screenshots/hello%20world.png?ref=refs%2Fpull%2F7%2Fhead",
      );
    }),
  );

  it.effect("rejects a contents response without a download URL", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestFile({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          path: "docs/screenshot.png",
        }),
      );

      assert.strictEqual(error._tag, "GitHubPullRequestFileUrlUnavailableError");
    }),
  );

  it.effect("rejects an oversized pull request image before proxying it", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output('{"download_url":"https://raw.example/large.png","size":10485761,"content":""}'),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestFile({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          path: "docs/large.png",
        }),
      );

      assert.strictEqual(error._tag, "GitHubPullRequestFileUrlUnavailableError");
    }),
  );

  it.effect("ends the diff on a page with no files rather than asking for it again", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        cursor: "4",
      });

      assert.strictEqual(diff.patch, "");
      assert.isNull(diff.nextCursor);
    }),
  );

  it.effect("reports the refused diff when the files API cannot answer either", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("not json")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );

      assert.strictEqual(error, diffRefused);
    }),
  );

  it.effect("skips the avatar lookup when a listing named nobody", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const avatars = yield* cli.listActorAvatars({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        ids: [],
      });

      assert.strictEqual(avatars.size, 0);
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("looks up avatars by node id in one GraphQL read", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                nodes: [
                  { __typename: "User", login: "octocat", avatarUrl: "https://avatars/octocat" },
                ],
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const avatars = yield* cli.listActorAvatars({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        ids: ["MDQ6VXNlcjE="],
      });

      expect(varsAt(0)).toEqual({ ids: ["MDQ6VXNlcjE="] });
      expect(avatars.get("octocat")).toBe("https://avatars/octocat");
    }),
  );

  it.effect("fails when the authenticated account has no login", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("  ")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(cli.getViewerLogin({ cwd: "/w", host: "github.com" }));

      assert.strictEqual(error._tag, "GitHubViewerLoginUnavailableError");
    }),
  );

  it.effect("looks up the authenticated account on the requested enterprise host", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output('{"id":456,"login":"enterprise-user"}')),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const login = yield* cli.getViewerLogin({ cwd: "/w", host: "github.acme.com" });

      expect(login).toBe("enterprise-user");
      expect(mockedCredential).toHaveBeenCalledWith("github.acme.com");
      expect(callAt(0)).toMatchObject({ kind: "rest", host: "github.acme.com", path: "user" });
    }),
  );

  it.effect("reuses verified credentials offline and refuses an unverified replacement", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const input = { cwd: "/w", host: "github.identity-cache.test" };
      mockedCredential.mockImplementation((host) =>
        Effect.succeed({ token: Redacted.make("test-credential-a"), fingerprint: `${host}:a` }),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output('{"id":123,"login":"maria-rcks"}')));
      expect(yield* cli.getRoutingIdentity(input)).toEqual({
        accountId: "123",
        viewer: "maria-rcks",
      });

      expect(yield* cli.getRoutingIdentity(input)).toEqual({
        accountId: "123",
        viewer: "maria-rcks",
      });
      expect(mockedExecute).toHaveBeenCalledTimes(1);

      mockedCredential.mockImplementation((host) =>
        Effect.succeed({ token: Redacted.make("test-credential-b"), fingerprint: `${host}:b` }),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.fail(
          new GitHubRequestPolicy.GitHubApiResponseError({
            host: "github.com",
            operation: "getRoutingIdentity",
            status: 502,
          }),
        ),
      );
      const failure = yield* cli.getRoutingIdentity(input).pipe(Effect.flip);
      expect(failure._tag).toBe("GitHubApiResponseError");
      expect(String(failure)).not.toContain("test-credential-b");
      expect(mockedExecute).toHaveBeenCalledTimes(2);

      mockedExecute.mockReturnValueOnce(Effect.succeed(output('{"id":456,"login":"maria-rcks"}')));
      expect(yield* cli.getRoutingIdentity(input)).toEqual({
        accountId: "456",
        viewer: "maria-rcks",
      });
    }),
  );

  it.effect("sends a whole review as one request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.submitReview({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        verdict: "approve",
        body: "Looks right.",
        comments: [{ path: "src/a.ts", position: { kind: "added", newLine: 4 }, body: "nit" }],
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(restCallsTo("/reviews")).toMatchObject([
        {
          method: "POST",
          path: "repos/acme/web/pulls/7/reviews",
          body: {
            event: "APPROVE",
            body: "Looks right.",
            comments: [{ path: "src/a.ts", line: 4, side: "RIGHT", body: "nit" }],
          },
        },
      ]);
    }),
  );

  it.effect("sends a reply body as a variable, never inside the document", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.replyToReviewThread({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        threadId: "PRRT_1",
        body: "Fixed in 42ff8ec.",
      });

      expect(variablesOf("addPullRequestReviewThreadReply(")).toEqual([
        { threadId: "PRRT_1", body: "Fixed in 42ff8ec." },
      ]);
      expect(queryAt(0)).not.toContain("Fixed in 42ff8ec.");
    }),
  );

  it.effect("resolves and unresolves through the mutation each one needs", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.setReviewThreadResolution({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        threadId: "PRRT_1",
        resolved: true,
      });
      yield* cli.setReviewThreadResolution({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        threadId: "PRRT_1",
        resolved: false,
      });

      expect(queryAt(0)).toContain("resolveReviewThread(");
      expect(queryAt(0)).not.toContain("unresolveReviewThread(");
      expect(queryAt(1)).toContain("unresolveReviewThread(");
      expect([varsAt(0), varsAt(1)]).toEqual([{ threadId: "PRRT_1" }, { threadId: "PRRT_1" }]);
      expect([callAt(0).host, callAt(1).host]).toEqual(["github.acme.dev", "github.acme.dev"]);
    }),
  );

  it.effect("confirms a given subject belongs to the named pull request, then reacts to it", () =>
    Effect.gen(function* () {
      route([SUBJECT_SCOPE_QUERY, subjectScope("IC_1", "PR_kwDOA")]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.setReaction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        subjectId: "IC_1",
        content: "heart",
        reacted: true,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      expect(variablesOf(SUBJECT_SCOPE_QUERY)).toEqual([
        { owner: "acme", name: "web", number: 7, subjectId: "IC_1" },
      ]);
      expect(variablesOf("addReaction(")).toEqual([{ subjectId: "IC_1", content: "HEART" }]);
    }),
  );

  it.effect("refuses a given subject that belongs to a different pull request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: { pullRequest: { id: "PR_thisOne" } },
                // A comment on pull request #99 of a different repository, named as though it
                // belonged to #7 here.
                node: {
                  __typename: "IssueComment",
                  id: "IC_99",
                  pullRequest: { id: "PR_someOtherOne" },
                },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.setReaction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          subjectId: "IC_99",
          content: "heart",
          reacted: true,
        }),
      );

      assert.strictEqual(error._tag, "GitHubSubjectScopeError");
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );

  it.effect("looks up the pull request's own node id when no subject was given", () =>
    Effect.gen(function* () {
      route([NODE_ID_QUERY, nodeIdAnswer("PR_kwDOA")]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.setReaction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 21,
        content: "rocket",
        reacted: true,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      expect(variablesOf(NODE_ID_QUERY)).toEqual([{ owner: "acme", name: "web", number: 21 }]);
      expect(variablesOf("addReaction(")).toEqual([{ subjectId: "PR_kwDOA", content: "ROCKET" }]);
    }),
  );

  it.effect("takes a reaction back through the remove mutation", () =>
    Effect.gen(function* () {
      route([SUBJECT_SCOPE_QUERY, subjectScope("IC_1", "PR_kwDOA")]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.setReaction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        subjectId: "IC_1",
        content: "heart",
        reacted: false,
      });

      expect(variablesOf("removeReaction(")).toEqual([{ subjectId: "IC_1", content: "HEART" }]);
      expect(variablesOf("addReaction(")).toEqual([]);
    }),
  );

  it.effect("rewrites only the words a request named", () =>
    Effect.gen(function* () {
      route([NODE_ID_QUERY, nodeIdAnswer("PR_kwDOA")]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const rewrite = (fields: { readonly title?: string; readonly body?: string }) =>
        cli.updatePullRequest({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 22,
          ...fields,
        });

      yield* rewrite({ title: "A better title" });
      yield* rewrite({ body: "A better description." });
      yield* rewrite({ title: "Both", body: "at once." });

      assert.strictEqual(variablesOf(NODE_ID_QUERY).length, 1);
      expect(variablesOf("updatePullRequest(")).toEqual([
        { pullRequestId: "PR_kwDOA", title: "A better title" },
        { pullRequestId: "PR_kwDOA", body: "A better description." },
        { pullRequestId: "PR_kwDOA", title: "Both", body: "at once." },
      ]);
    }),
  );

  it.effect("rewrites a remark through the mutation its kind needs", () =>
    Effect.gen(function* () {
      route([SUBJECT_SCOPE_QUERY, subjectScope("IC_1", "PR_kwDOA")]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const rewrite = (kind: "issue-comment" | "review-comment") =>
        cli.updateComment({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          commentId: "IC_1",
          kind,
          body: "Reworded.",
        });

      yield* rewrite("issue-comment");
      yield* rewrite("review-comment");

      expect(variablesOf(SUBJECT_SCOPE_QUERY).map((variables) => variables["subjectId"])).toEqual([
        "IC_1",
        "IC_1",
      ]);
      expect(variablesOf("updateIssueComment(")).toEqual([
        { commentId: "IC_1", body: "Reworded." },
      ]);
      expect(variablesOf("updatePullRequestReviewComment(")).toEqual([
        { commentId: "IC_1", body: "Reworded." },
      ]);
    }),
  );

  it.effect("refuses a comment that belongs to a different pull request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: { pullRequest: { id: "PR_thisOne" } },
                node: {
                  __typename: "IssueComment",
                  id: "IC_99",
                  pullRequest: { id: "PR_someOtherOne" },
                },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.updateComment({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          commentId: "IC_99",
          kind: "issue-comment",
          body: "Reworded.",
        }),
      );

      assert.strictEqual(error._tag, "GitHubSubjectScopeError");
      if (error._tag === "GitHubSubjectScopeError")
        assert.strictEqual(error.operation, "updateComment");
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );

  it.effect("fails the read when gh returns something unreadable", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output('{"message":"not found"}')));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDetail({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );

      assert.strictEqual(error._tag, "GitHubPullRequestReadError");
    }),
  );

  it.effect("keeps the core detail read separate from conversation activity", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson(
              coreResponse({
                title: "Progressive detail",
                author: {
                  __typename: "User",
                  id: "U_octocat",
                  login: "octocat",
                  name: null,
                  avatarUrl: "https://a/o",
                },
                body: "Core body",
                changedFiles: 2,
              }),
            ),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    author: {
                      __typename: "User",
                      login: "octocat",
                      avatarUrl: "https://a/o",
                      name: null,
                    },
                    commits: { nodes: [] },
                    comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                    reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                  },
                },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const input = {
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      } as const;

      const detail = yield* cli.getPullRequestDetail(input);
      const activity = yield* cli.getPullRequestActivity(input);

      expect(detail.body).toBe("Core body");
      expect(activity.author?.login).toBe("octocat");
      expect(varsAt(0)).toMatchObject({ number: 7, headRef: "refs/pull/7/head" });
      expect(queryAt(0)).toContain("viewerCanUpdateBranch");
      expect(queryAt(0)).not.toContain("reviews(");
      expect(detail.viewerAccess.mergeCapabilities).toEqual({
        merge: true,
        squash: false,
        rebase: true,
      });
      expect(detail.comparison).toEqual({ behindBy: 2, viewerCanUpdate: true });
      expect(queryAt(1)).toContain("reviews(");
      expect(varsAt(1)).toMatchObject({ head: true, withComments: true, withReviews: true });
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect("keeps the latest attempt per environment across PR history and the head commit", () =>
    Effect.gen(function* () {
      const deployment = (id: string, environment: string, createdAt: string) => ({
        id,
        environment,
        createdAt,
        updatedAt: "2026-07-03T00:00:00Z",
        state: "ACTIVE",
        commitOid: "abc123",
        latestStatus: {
          state: "SUCCESS",
          updatedAt: "2026-07-03T00:01:00Z",
          description: "Ready",
          environmentUrl: "https://preview.example.com",
          logUrl: "https://example.com/logs",
        },
      });
      const old = {
        ...deployment("old", "preview", "2026-07-01T00:00:00Z"),
        state: "INACTIVE",
        updatedAt: "2026-07-04T00:00:00Z",
      };
      const current = deployment("current", "preview", "2026-07-02T00:00:00Z");
      // GitHub timestamps have second precision; a new head attempt can tie the prior one.
      const pending = { ...current, id: "building", state: "PENDING", latestStatus: null };
      const failed = {
        ...deployment("failed", "staging", "2026-07-02T01:00:00Z"),
        state: "ERROR",
        latestStatus: {
          state: "ERROR",
          updatedAt: "2026-07-02T01:05:00Z",
          description: "Build failed",
          environmentUrl: "javascript:alert(1)",
          logUrl: "https://example.com/failure",
        },
      };
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson(
              coreResponse({
                timelineItems: {
                  nodes: [
                    { __typename: "DeployedEvent", deployment: old },
                    null,
                    { __typename: "DeployedEvent", deployment: current },
                    { __typename: "DeployedEvent", deployment: failed },
                  ],
                  pageInfo: { hasPreviousPage: true },
                },
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: null,
                        deployments: { nodes: [pending, null], pageInfo: { hasNextPage: false } },
                      },
                    },
                  ],
                },
              }),
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const detail = yield* cli.getPullRequestDetail({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });
      expect(detail.deployments).toEqual([
        {
          id: "building",
          environment: "preview",
          status: "pending",
          description: null,
          environmentUrl: null,
          logUrl: null,
          commitSha: "abc123",
          createdAt: "2026-07-02T00:00:00Z",
          updatedAt: "2026-07-03T00:00:00Z",
        },
        {
          id: "failed",
          environment: "staging",
          status: "error",
          description: "Build failed",
          environmentUrl: null,
          logUrl: "https://example.com/failure",
          commitSha: "abc123",
          createdAt: "2026-07-02T01:00:00Z",
          updatedAt: "2026-07-02T01:05:00Z",
        },
      ]);
      expect(detail.deploymentsTruncated).toBe(true);
      expect(mockedExecute).toHaveBeenCalledOnce();
    }),
  );

  it.effect(
    "reports pending, inactive and unfamiliar deployment states without guessing success",
    () =>
      Effect.gen(function* () {
        const nodes = [
          "PENDING",
          "QUEUED",
          "WAITING",
          "IN_PROGRESS",
          "FAILURE",
          "DESTROYED",
          "FUTURE_STATE",
          "ACTIVE",
          "SUCCESS",
          "ABANDONED",
        ].map((state) => ({
          id: state,
          environment: state,
          state,
          commitOid: "head",
          createdAt: "2026-07-02T00:00:00Z",
          updatedAt: "2026-07-02T00:00:00Z",
          latestStatus:
            state === "ABANDONED"
              ? {
                  state: "PENDING",
                  updatedAt: "2026-07-02T00:00:00Z",
                  description: null,
                  environmentUrl: null,
                  logUrl: null,
                }
              : null,
        }));
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(
            output(
              encodeJson(
                coreResponse({
                  timelineItems: { nodes: [], pageInfo: { hasPreviousPage: false } },
                  commits: {
                    nodes: [
                      {
                        commit: {
                          statusCheckRollup: null,
                          deployments: { nodes, pageInfo: { hasNextPage: false } },
                        },
                      },
                    ],
                  },
                }),
              ),
            ),
          ),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const detail = yield* cli.getPullRequestDetail({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        });
        expect(
          Object.fromEntries(
            detail.deployments?.map((deployment) => [deployment.environment, deployment.status]) ??
              [],
          ),
        ).toEqual({
          PENDING: "pending",
          QUEUED: "queued",
          WAITING: "waiting",
          IN_PROGRESS: "in-progress",
          FAILURE: "failure",
          DESTROYED: "inactive",
          FUTURE_STATE: "unknown",
          ACTIVE: "success",
          SUCCESS: "success",
          ABANDONED: "inactive",
        });
        expect(detail.deploymentsTruncated).toBe(false);
      }),
  );

  it.effect("keeps PR detail readable when deployment fields are refused", () =>
    Effect.gen(function* () {
      const context = { host: "github.com", operation: "getPullRequestDetail" };
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      for (const failure of [
        new GitHubRequestPolicy.GitHubApiResponseError({ ...context, status: 403 }),
        new GitHubRequestPolicy.GitHubApiNotFoundError(context),
      ]) {
        mockedExecute.mockReturnValueOnce(Effect.fail(failure));
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(
            output(encodeJson(coreResponse({ title: "Readable without deployments" }))),
          ),
        );
        const detail = yield* cli.getPullRequestDetail({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        });
        expect(detail.title).toBe("Readable without deployments");
        expect(detail.viewerAccess.canWrite).toBe(true);
        expect(detail.deployments).toBeUndefined();
      }
      expect(mockedExecute).toHaveBeenCalledTimes(4);
      for (const index of [0, 2]) {
        expect(varsAt(index)["deployments"]).toBe(true);
        expect(queryAt(index + 1)).not.toContain("deployments(");
      }
    }),
  );

  it.effect("preserves authentication and quota failures without a fallback request", () =>
    Effect.gen(function* () {
      const context = { host: "github.com", operation: "getPullRequestDetail" };
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      for (const failure of [
        new GitHubRequestPolicy.GitHubApiAuthenticationError(context),
        new GitHubRequestPolicy.GitHubApiRateLimitError(context),
      ]) {
        mockedExecute.mockReturnValueOnce(Effect.fail(failure));
        const error = yield* Effect.flip(
          cli.getPullRequestDetail({
            cwd: "/w",
            repository: "acme/web",
            host: "github.com",
            number: 7,
          }),
        );
        expect(error._tag).toBe(failure._tag);
      }
      expect(mockedExecute).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("stops after one fallback when the PR itself is inaccessible", () =>
    Effect.gen(function* () {
      const failure = new GitHubRequestPolicy.GitHubApiNotFoundError({
        host: "github.com",
        operation: "getPullRequestDetail",
      });
      mockedExecute.mockReturnValue(Effect.fail(failure));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const error = yield* Effect.flip(
        cli.getPullRequestDetail({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );
      expect(error._tag).toBe(failure._tag);
      expect(mockedExecute).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect.each([
    {
      name: "check path",
      errors: [
        {
          ...refusedReviewer,
          path: ["repository", "pullRequest", "commits", "nodes", 0, "commit", "statusCheckRollup"],
        },
      ],
    },
    {
      name: "mixed errors",
      errors: [refusedReviewer, { ...refusedReviewer, path: [...refusedReviewer.path, "login"] }],
    },
    {
      name: "untyped error",
      errors: [{ message: refusedReviewer.message, path: refusedReviewer.path }],
    },
    {
      name: "negative index",
      errors: [
        {
          ...refusedReviewer,
          path: ["repository", "pullRequest", "reviewRequests", "nodes", -1, "requestedReviewer"],
        },
      ],
    },
    { name: "HTTP 403", errors: [refusedReviewer], status: 403 },
    {
      name: "authentication",
      errors: [refusedReviewer],
      status: 401,
      tag: "GitHubApiAuthenticationError",
    },
    { name: "rate limit", errors: [refusedReviewer], status: 429, tag: "GitHubApiRateLimitError" },
    {
      name: "GraphQL rate limit",
      errors: [refusedReviewer, { message: "API rate limit exceeded", type: "RATE_LIMITED" }],
      tag: "GitHubApiRateLimitError",
    },
  ])("does not retry a reviewer refusal with $name", ({ name, errors, status = 200, tag }) =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            encodeJson(status === 401 ? { message: "Bad credentials" } : { data: null, errors }),
            false,
            false,
            {},
            status,
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const reads: ReadonlyArray<PullRequestRead> = [
        cli.getPullRequestDetail,
        cli.listReviewThreadComments,
      ];
      for (const [index, read] of reads.entries()) {
        const error = yield* read({
          ...pullRequestInput,
          host: `github-${name.replaceAll(" ", "-")}-${index}.test`,
        }).pipe(Effect.asVoid, Effect.flip);
        expect(error._tag).toBe(tag ?? "GitHubApiResponseError");
        if (error._tag === "GitHubApiResponseError")
          expect(error).toMatchObject({ status, githubErrors: errors.map((e) => e.message) });
        expect(mockedExecute).toHaveBeenCalledTimes(index + (tag === undefined ? 2 : 1));
      }
    }),
  );

  it.effect.each(["detail", "threads"] as const)("fails a refused retry of %s", (kind) =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(refusedReviewerResponse());
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const read: PullRequestRead =
        kind === "detail" ? cli.getPullRequestDetail : cli.listReviewThreadComments;
      const error = yield* read(pullRequestInput).pipe(Effect.asVoid, Effect.flip);
      expect(error._tag).toBe("GitHubApiResponseError");
      expect(mockedExecute).toHaveBeenCalledTimes(kind === "detail" ? 4 : 2);
      expect(varsAt(1)["requestedReviewers"]).toBe(0);
    }),
  );

  it.effect.each([false, true])(
    "keeps thread cursors and reviewers after a refusal (later page: %s)",
    (later) =>
      Effect.gen(function* () {
        if (later)
          mockedExecute.mockReturnValueOnce(
            Effect.succeed(
              output(
                reviewThreadsPage([thread("T1", "c1")], "next", [
                  {
                    __typename: "User",
                    login: "prior",
                    name: null,
                    avatarUrl: "https://avatars/prior",
                  },
                ]),
              ),
            ),
          );
        mockedExecute.mockReturnValueOnce(refusedReviewerResponse());
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(output(reviewThreadsPage([thread("T2", "c2")], "last"))),
        );
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(output(reviewThreadsPage([thread("T3", "c3")], null))),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const read = cli.listReviewThreadComments(pullRequestInput);
        const conversation = yield* read;
        expect(
          variablesOf("ReviewThreads").map((v) => [v["after"], v["requestedReviewers"]]),
        ).toEqual(
          later
            ? [
                [null, 50],
                ["next", 50],
                ["next", 0],
                ["last", 0],
              ]
            : [
                [null, 50],
                [null, 0],
                ["last", 0],
              ],
        );
        expect(conversation.comments.map((c) => c.id)).toEqual(
          later ? ["c1", "c2", "c3"] : ["c2", "c3"],
        );
        expect(conversation.reviewers.map((r) => r.login)).toEqual(later ? ["prior"] : []);
        expect(conversation.truncated).toBe(false);

        mockedExecute.mockReturnValueOnce(Effect.succeed(output(reviewThreadsPage([], null))));
        yield* read;
        expect(variablesOf("ReviewThreads").at(-1)).toMatchObject({
          after: null,
          requestedReviewers: 50,
        });
      }),
  );

  it.effect("retries review threads once per read", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(refusedReviewerResponse());
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(reviewThreadsPage([], "next"))));
      mockedExecute.mockReturnValueOnce(refusedReviewerResponse());
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      expect((yield* Effect.flip(cli.listReviewThreadComments(pullRequestInput)))._tag).toBe(
        "GitHubApiResponseError",
      );
      expect(mockedExecute).toHaveBeenCalledTimes(3);
      expect(varsAt(2)).toMatchObject({ after: "next", requestedReviewers: 0 });
    }),
  );

  it.effect("decodes reviewers, labels and workflow checks without another detail read", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson(
              coreResponse({
                baseRef: null,
                reviewRequests: {
                  nodes: [
                    { requestedReviewer: { __typename: "User", login: "reviewer", name: null } },
                    {
                      requestedReviewer: {
                        __typename: "Team",
                        slug: "maintainers",
                        combinedSlug: "octo/maintainers",
                        teamName: "Maintainers",
                        teamAvatarUrl: "https://avatars.githubusercontent.com/t/1",
                      },
                    },
                  ],
                },
                labels: { nodes: [{ name: "bug", color: "ff0000" }] },
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: {
                          contexts: {
                            nodes: [
                              checkRun({
                                name: "build",
                                status: "COMPLETED",
                                conclusion: "SUCCESS",
                                checkSuite: { workflowRun: { workflow: { name: "linux" } } },
                              }),
                              checkRun({
                                name: "build",
                                status: "COMPLETED",
                                conclusion: "FAILURE",
                                checkSuite: { workflowRun: { workflow: { name: "windows" } } },
                              }),
                            ],
                            pageInfo: { hasNextPage: false },
                          },
                        },
                      },
                    },
                  ],
                },
              }),
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const detail = yield* cli.getPullRequestDetail({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });
      expect(mockedExecute).toHaveBeenCalledOnce();
      expect(detail.comparison).toBeNull();
      expect(detail.reviewRequestLogins).toEqual(["reviewer"]);
      expect(detail.hasTeamReviewRequest).toBe(true);
      expect(detail.reviewRequestTeams).toEqual([
        {
          login: "octo/maintainers",
          name: "Maintainers",
          avatarUrl: "https://avatars.githubusercontent.com/t/1",
        },
      ]);
      expect(detail.labels).toEqual([{ name: "bug", color: "ff0000" }]);
      expect(detail.checks).toHaveLength(2);
      expect(detail.checksState).toBe("failing");
    }),
  );

  it.effect.each([false, true])(
    "reads every check when the combined response has another page (reviewer refusal: %s)",
    (refused) =>
      Effect.gen(function* () {
        if (refused) mockedExecute.mockReturnValueOnce(refusedReviewerResponse());
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(
            output(
              encodeJson(
                coreResponse({
                  commits: {
                    nodes: [
                      {
                        commit: {
                          statusCheckRollup: {
                            contexts: {
                              nodes: [
                                checkRun({
                                  name: "first",
                                  status: "COMPLETED",
                                  conclusion: "SUCCESS",
                                }),
                              ],
                              pageInfo: { hasNextPage: true, endCursor: "c1" },
                            },
                          },
                        },
                      },
                    ],
                  },
                }),
              ),
            ),
          ),
        );
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(
            output(
              checkContextsPage(
                [
                  checkRun({ name: "first", status: "COMPLETED", conclusion: "SUCCESS" }),
                  checkRun({ name: "last", status: "COMPLETED", conclusion: "FAILURE" }),
                ],
                null,
              ),
            ),
          ),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const read = cli.getPullRequestDetail(pullRequestInput);
        const detail = yield* read;
        expect(detail.reviewRequestLogins).toEqual([]);
        expect(detail.reviewRequestTeams).toEqual([]);
        expect(detail.hasTeamReviewRequest).toBe(false);
        if (refused)
          expect(variablesOf("PullRequestCore").map((v) => v["requestedReviewers"])).toEqual([
            100, 0,
          ]);
        expect(detail.checks).toHaveLength(2);
        expect(detail.checksState).toBe("failing");
        expect(detail.checksTruncated).toBe(false);
        // The whole rollup is walked from its start, so no check is counted twice or skipped.
        expect(variablesOf("CheckContexts")).toEqual([expect.objectContaining({ number: 7 })]);
        expect(variablesOf("CheckContexts")[0]).not.toHaveProperty("after");
        expect(mockedExecute).toHaveBeenCalledTimes(refused ? 3 : 2);

        if (refused) {
          mockedExecute.mockReturnValueOnce(Effect.succeed(output(encodeJson(coreResponse()))));
          yield* read;
          expect(variablesOf("PullRequestCore").at(-1)).toMatchObject({ requestedReviewers: 100 });
        }
      }),
  );

  it.effect.each([false, true])(
    "refuses to combine checks from different head revisions (reviewer refusal: %s)",
    (refused) =>
      Effect.gen(function* () {
        if (refused) mockedExecute.mockReturnValueOnce(refusedReviewerResponse());
        const response = coreResponse({
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [],
                      pageInfo: { hasNextPage: true },
                    },
                  },
                },
              },
            ],
          },
        });
        mockedExecute.mockReturnValueOnce(Effect.succeed(output(encodeJson(response))));
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(output(checkContextsPage([], null, "new-head"))),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const error = yield* Effect.flip(
          cli.getPullRequestDetail({
            cwd: "/w",
            repository: "acme/web",
            host: "github.com",
            number: 7,
          }),
        );
        expect(error._tag).toBe("GitHubPullRequestReadError");
      }),
  );

  it.effect("preserves the reserve for automatic detail reads and allows manual checks", () =>
    Effect.gen(function* () {
      const response = coreResponse();
      mockedExecute.mockReturnValue(
        Effect.succeed(output(encodeJson(response), false, false, graphqlQuota(499))),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const input = {
        cwd: "/w",
        repository: "acme/web",
        host: "github.core-reserve.test",
        number: 7,
      };
      yield* cli.getPullRequestDetail(input);
      const error = yield* Effect.flip(cli.getPullRequestDetail(input));
      expect(error._tag).toBe("SourceControlRateLimitPausedError");
      expect(mockedExecute).toHaveBeenCalledOnce();
      yield* cli
        .getPullRequestDetail(input)
        .pipe(Effect.provideService(SourceControlRateLimit.Interactive, true));
      expect(mockedExecute).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("reads the required checks from GitHub's per-pull-request answer on any host", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    headRefOid: "abc123",
                    commits: {
                      nodes: [
                        {
                          commit: {
                            statusCheckRollup: {
                              contexts: {
                                nodes: [
                                  checkRun({
                                    name: "build",
                                    detailsUrl: "https://example.test/checks/build",
                                    isRequired: true,
                                  }),
                                  checkRun({ name: "lint", isRequired: false }),
                                ],
                                pageInfo: { hasNextPage: false, endCursor: null },
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const checks = yield* cli.getRequiredChecks({
        cwd: "/w",
        repository: "acme/web",
        host: "github.example.test",
        number: 7,
      });

      expect(checks).toEqual([{ name: "build", url: "https://example.test/checks/build" }]);
      // Asked of an Enterprise host too: a schema that predates it fails the read, which the
      // caller reads as unknown rather than as no required checks.
      expect(queryAt(0)).toContain("isRequired(pullRequestNumber:$number)");
      expect(varsAt(0)).toMatchObject({ owner: "acme", name: "web", number: 7, required: true });
    }),
  );

  it.effect("answers no required checks for a head that reports no checks", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    headRefOid: "abc123",
                    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
                  },
                },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const checks = yield* cli.getRequiredChecks({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      expect(checks).toEqual([]);
    }),
  );

  it.effect("unions effective ruleset and classic branch-protection required checks", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((input) =>
        Effect.succeed(
          output(
            input.kind === "rest" &&
              input.path.includes("repos/acme/web/rules/branches/release%2Fnext")
              ? JSON.stringify([
                  {
                    type: "required_status_checks",
                    parameters: {
                      strict_required_status_checks_policy: true,
                      required_status_checks: [
                        { context: "build", integration_id: 1 },
                        { context: "security", integration_id: 2 },
                      ],
                    },
                  },
                ])
              : JSON.stringify({
                  data: {
                    repository: {
                      ref: {
                        branchProtectionRule: {
                          requiredStatusCheckContexts: ["legacy", "build"],
                          requiresStrictStatusChecks: false,
                        },
                      },
                    },
                  },
                }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const policy = yield* cli.getBranchPolicy({
        cwd: "/w",
        repository: "acme/web",
        host: "github.example.test",
        baseBranch: "release/next",
      });

      expect(policy.requiredChecks).toEqual(["build", "security", "legacy"]);
      expect(policy.requiresUpToDateBranch).toBe(true);
      expect(restCallsTo("rules/branches").map((call) => [call.host, call.path])).toEqual([
        ["github.example.test", "repos/acme/web/rules/branches/release%2Fnext?per_page=100&page=1"],
      ]);
      expect(variablesOf("branchProtectionRule")).toEqual([
        { owner: "acme", name: "web", qualifiedName: "refs/heads/release/next" },
      ]);
    }),
  );

  it.effect("keeps classic protection when the host has no rulesets endpoint", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((input) =>
        input.kind === "rest" && input.path.includes("repos/acme/web/rules/branches/main")
          ? Effect.fail(diffRefused)
          : Effect.succeed(
              output(
                JSON.stringify({
                  data: {
                    repository: {
                      ref: {
                        branchProtectionRule: {
                          requiredStatusCheckContexts: ["classic"],
                          requiresStrictStatusChecks: true,
                        },
                      },
                    },
                  },
                }),
              ),
            ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const policy = yield* cli.getBranchPolicy({
        cwd: "/w",
        repository: "acme/web",
        host: "github.example.test",
        baseBranch: "main",
      });
      expect(policy.requiredChecks).toEqual(["classic"]);
      expect(policy.requiresUpToDateBranch).toBe(true);
    }),
  );

  it.effect("does not claim an update is optional when a policy source is unavailable", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((input) =>
        input.kind === "rest" && input.path.includes("repos/acme/web/rules/branches/main")
          ? Effect.fail(diffRefused)
          : Effect.succeed(
              output(
                JSON.stringify({
                  data: {
                    repository: {
                      ref: {
                        branchProtectionRule: {
                          requiredStatusCheckContexts: ["build"],
                          requiresStrictStatusChecks: false,
                        },
                      },
                    },
                  },
                }),
              ),
            ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const policy = yield* cli.getBranchPolicy({
        cwd: "/w",
        repository: "acme/web",
        host: "github.example.test",
        baseBranch: "main",
      });
      expect(policy.requiredChecks).toEqual(["build"]);
      expect(policy.requiresUpToDateBranch).toBeUndefined();
    }),
  );

  it.effect("reports a loose policy when both effective policy sources agree", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((input) =>
        Effect.succeed(
          output(
            input.kind === "rest" && input.path.includes("repos/acme/web/rules/branches/main")
              ? JSON.stringify([
                  {
                    type: "required_status_checks",
                    parameters: {
                      strict_required_status_checks_policy: false,
                      required_status_checks: [{ context: "build" }],
                    },
                  },
                ])
              : JSON.stringify({
                  data: {
                    repository: { ref: { branchProtectionRule: null } },
                  },
                }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const policy = yield* cli.getBranchPolicy({
        cwd: "/w",
        repository: "acme/web",
        host: "github.example.test",
        baseBranch: "main",
      });
      expect(policy.requiresUpToDateBranch).toBe(false);
    }),
  );

  it.effect("does not call an incomplete ruleset loose when classic protection is loose", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((input) =>
        Effect.succeed(
          output(
            input.kind === "rest" && input.path.includes("repos/acme/web/rules/branches/main")
              ? JSON.stringify([
                  {
                    type: "required_status_checks",
                    parameters: { required_status_checks: [{ context: "build" }] },
                  },
                ])
              : JSON.stringify({
                  data: {
                    repository: {
                      ref: {
                        branchProtectionRule: {
                          requiredStatusCheckContexts: ["classic"],
                          requiresStrictStatusChecks: false,
                        },
                      },
                    },
                  },
                }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const policy = yield* cli.getBranchPolicy({
        cwd: "/w",
        repository: "acme/web",
        host: "github.example.test",
        baseBranch: "main",
      });
      expect(policy.requiredChecks).toEqual(["build", "classic"]);
      expect(policy.requiresUpToDateBranch).toBeUndefined();
    }),
  );

  it.effect("leaves required-check policy unknown when neither source is available", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.fail(diffRefused));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getBranchPolicy({
          cwd: "/w",
          repository: "acme/web",
          host: "github.example.test",
          baseBranch: "main",
        }),
      );

      expect(error._tag).toBe("GitHubPullRequestReadError");
    }),
  );

  it.effect("fails a files page too large to read rather than calling the diff whole", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(1, 1), true)));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );

      assert.strictEqual(error, diffRefused);
    }),
  );

  it.effect("pages an oversized patch by file rather than handing back a severed one", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output("diff --git a/a b/a\n@@ -1 +1 @@", true)),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(1, 1))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const slice = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.strictEqual(pathAt(1), "repos/acme/web/pulls/7/files?per_page=100&page=1");
      expect(slice.patch).toContain("src/file1.ts");
      expect(slice.patch).not.toContain("diff --git a/a b/a");
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect("follows the cursor to the review threads the first page left behind", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(reviewThreadsPage([thread("PRRT_1", "c1")], "Y3Vyc29yOjE"))),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(reviewThreadsPage([thread("PRRT_2", "c2")], null))),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const conversation = yield* cli.listReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      // The first page asks from the beginning; the next carries on from where it stopped.
      expect(varsAt(0)["after"]).toBeNull();
      expect(varsAt(1)["after"]).toBe("Y3Vyc29yOjE");
      expect(conversation.comments.map((comment) => comment.id)).toEqual(["c1", "c2"]);
      assert.isFalse(conversation.truncated);
    }),
  );

  it.effect("stops at the thread bound and says the conversation was cut short", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            reviewThreadsPage(
              [{ ...thread("PRRT_1", "c1"), comments: threadComments(["c1"], "Y3Vyc29yOjI", 3) }],
              "Y3Vyc29yOjE",
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const conversation = yield* cli.listReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      // Twenty-five threads per deliberately narrow query, up to the same thousand-thread
      // traversal ceiling the former hundred-row query provided.
      assert.strictEqual(mockedExecute.mock.calls.length, 40);
      assert.isTrue(conversation.truncated);
      assert.isTrue(conversation.reviewThreadsTruncated);
    }),
  );

  it.effect("leaves a long thread paged until the reader asks for more", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            reviewThreadsPage(
              [{ ...thread("PRRT_1", "c1"), comments: threadComments(["c1"], "Y3Vyc29yOjI", 3) }],
              null,
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const conversation = yield* cli.listReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(conversation.comments.map((comment) => comment.id)).toEqual(["c1"]);
      expect(conversation.reviewThreads[0]).toMatchObject({
        commentCount: 3,
        nextCommentsCursor: "Y3Vyc29yOjI",
      });
      assert.isTrue(conversation.truncated);
      assert.isFalse(conversation.reviewThreadsTruncated);
    }),
  );

  it.effect("reads one requested page from a review thread cursor", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(threadCommentsPage(["c2", "c3"], null, 3))),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const page = yield* cli.getReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        threadId: "PRRT_1",
        cursor: "Y3Vyc29yOjI",
      });

      expect(varsAt(0)).toMatchObject({
        owner: "acme",
        name: "web",
        number: 7,
        threadId: "PRRT_1",
        after: "Y3Vyc29yOjI",
      });
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(page.comments.map((comment) => comment.id)).toEqual(["c2", "c3"]);
      expect(page.nextCursor).toBeNull();
    }),
  );

  it.effect("refuses a review thread from another pull request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(threadCommentsPage(["foreign"], null, 1, "PR_8"))),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getReviewThreadComments({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          threadId: "PRRT_FOREIGN",
          cursor: "Y3Vyc29yOjI",
        }),
      );

      assert.strictEqual(error._tag, "GitHubSubjectScopeError");
    }),
  );

  it.effect(
    "keeps the reader's standing when the optional auto-merge permission read is unavailable",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockReturnValue(
          Effect.succeed(
            output(
              encodeJson({
                data: {
                  repository: {
                    mergeCommitAllowed: true,
                    squashMergeAllowed: false,
                    rebaseMergeAllowed: true,
                    autoMergeAllowed: true,
                    viewerPermission: "READ",
                    pullRequest: {
                      viewerCanUpdate: true,
                      viewerDidAuthor: true,
                      headRepository: null,
                    },
                  },
                },
              }),
            ),
          ),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

        const access = yield* cli.getViewerAccess({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        });

        // The core answer survives the second query failing, as it would on a GitHub Enterprise
        // schema that predates the auto-merge fields.
        assert.strictEqual(mockedExecute.mock.calls.length, 2);
        expect(varsAt(0)).toMatchObject({ owner: "acme", name: "web", number: 7 });
        expect(queryAt(0)).toContain("mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed");
        expect(access).toEqual({
          mergeCapabilities: { merge: true, squash: false, rebase: true },
          autoMergeAllowed: true,
          canWrite: false,
          canDeleteBranch: false,
          canTriage: false,
          canUpdate: true,
          didAuthor: true,
        });
      }),
  );

  it.effect("stops GraphQL reads at the protected reserve until reset", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  mergeCommitAllowed: true,
                  squashMergeAllowed: false,
                  rebaseMergeAllowed: true,
                  autoMergeAllowed: true,
                  viewerPermission: "READ",
                  pullRequest: {
                    viewerCanUpdate: true,
                    viewerDidAuthor: true,
                    headRepository: null,
                  },
                },
              },
            }),
            false,
            false,
            graphqlQuota(499),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const input = {
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      } as const;

      yield* cli.getViewerAccess(input);

      const error = yield* Effect.flip(cli.getViewerAccess(input));

      assert.strictEqual(error._tag, "SourceControlRateLimitPausedError");
      if (error._tag !== "SourceControlRateLimitPausedError") return;
      assert.strictEqual(error.host, "github.com");
      assert.strictEqual(error.retryAt, Date.parse("2099-08-13T14:00:00Z"));
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      yield* TestClock.setTime(Date.parse("2100-01-01T00:00:00Z"));
    }),
  );

  it.effect("reads exact auto-merge permissions with the detail on github.com only", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            encodeJson(
              coreResponse({ viewerCanEnableAutoMerge: false, viewerCanDisableAutoMerge: true }),
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const read = (host: string) =>
        cli.getPullRequestDetail({ cwd: "/w", repository: "acme/web", host, number: 7 });

      const detail = yield* read("github.com");
      expect(detail.viewerAccess).toMatchObject({
        canEnableAutoMerge: false,
        canDisableAutoMerge: true,
      });
      expect(varsAt(0)["required"]).toBe(true);

      // An Enterprise schema may predate the fields, and an unknown field fails the whole read.
      yield* read("github.example.test");
      expect(queryAt(1)).not.toContain("viewerCanEnableAutoMerge");
    }),
  );

  it.effect(
    "reads exact auto-merge access separately and keeps false permissions on writable repositories",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockImplementation((call) =>
          Effect.succeed(
            output(
              encodeJson(
                call.kind === "graphql" && call.operationName === "AutoMergePermissions"
                  ? {
                      data: {
                        repository: {
                          pullRequest: {
                            viewerCanEnableAutoMerge: false,
                            viewerCanDisableAutoMerge: true,
                            viewerCanMergeAsAdmin: true,
                            isMergeQueueEnabled: false,
                          },
                        },
                      },
                    }
                  : {
                      data: {
                        repository: {
                          mergeCommitAllowed: true,
                          squashMergeAllowed: true,
                          rebaseMergeAllowed: true,
                          autoMergeAllowed: true,
                          viewerPermission: "WRITE",
                          pullRequest: {
                            viewerCanUpdate: true,
                            viewerDidAuthor: false,
                            headRepository: null,
                          },
                        },
                      },
                    },
              ),
            ),
          ),
        );
        const api = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        expect(
          yield* api.getViewerAccess({
            cwd: "/w",
            host: "github.example.test",
            repository: "acme/web",
            number: 7,
          }),
        ).toMatchObject({
          canWrite: true,
          canEnableAutoMerge: false,
          canDisableAutoMerge: true,
          canMergeAsAdmin: true,
        });
        expect(variablesOf("ViewerPermissions")).toHaveLength(1);
        expect(variablesOf("AutoMergePermissions")).toHaveLength(1);
      }),
  );

  it.effect("lets an interactive permission read use the protected reserve", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              encodeJson({
                data: {
                  repository: {
                    mergeCommitAllowed: true,
                    squashMergeAllowed: false,
                    rebaseMergeAllowed: true,
                    autoMergeAllowed: true,
                    viewerPermission: "READ",
                    pullRequest: {
                      viewerCanUpdate: true,
                      viewerDidAuthor: true,
                      headRepository: null,
                    },
                  },
                },
              }),
              false,
              false,
              graphqlQuota(499),
            ),
          ),
        )
        .mockReturnValue(
          Effect.succeed(
            output(
              encodeJson({
                data: {
                  repository: {
                    mergeCommitAllowed: true,
                    squashMergeAllowed: false,
                    rebaseMergeAllowed: true,
                    autoMergeAllowed: true,
                    viewerPermission: "READ",
                    pullRequest: {
                      viewerCanUpdate: true,
                      viewerDidAuthor: true,
                      headRepository: null,
                    },
                  },
                },
              }),
            ),
          ),
        );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.getViewerAccess({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });
      const access = yield* cli.getViewerAccess({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        allowReserve: true,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 4);
      expect(access).toEqual({
        mergeCapabilities: { merge: true, squash: false, rebase: true },
        autoMergeAllowed: true,
        canWrite: false,
        canDeleteBranch: false,
        canTriage: false,
        canUpdate: true,
        didAuthor: true,
      });
      yield* TestClock.setTime(Date.parse("2100-01-01T00:00:00Z"));
    }),
  );

  it.effect("asks GitHub to review, naming the collection a request is added to", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.setReviewerRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        reviewers: [
          { id: "octocat", kind: "user" },
          { id: "reviewers", kind: "team" },
        ],
        requested: true,
      });

      expect(callAt(0)).toMatchObject({
        kind: "rest",
        method: "POST",
        path: "repos/acme/web/pulls/7/requested_reviewers",
        body: { reviewers: ["octocat"], team_reviewers: ["reviewers"] },
      });
    }),
  );

  it.effect("takes a request back by deleting from the same collection it was added to", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.setReviewerRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        reviewers: [{ id: "octocat", kind: "user" }],
        requested: false,
      });

      expect(callAt(0)).toMatchObject({
        kind: "rest",
        method: "DELETE",
        path: "repos/acme/web/pulls/7/requested_reviewers",
        body: { reviewers: ["octocat"], team_reviewers: [] },
      });
    }),
  );

  it.effect("reads who may review and who already has in one request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  assignableUsers: {
                    pageInfo: { hasNextPage: false },
                    nodes: ["bilal", "octocat", "hubot"].map((login) => ({
                      login,
                      name: null,
                      avatarUrl: `https://avatars/${login}`,
                    })),
                  },
                  pullRequest: {
                    author: { __typename: "User", login: "bilal" },
                    reviewRequests: {
                      nodes: [
                        {
                          requestedReviewer: {
                            __typename: "User",
                            login: "octocat",
                            name: null,
                            avatarUrl: "https://avatars/octocat",
                          },
                        },
                      ],
                    },
                  },
                },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const list = yield* cli.listReviewerCandidates({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(varsAt(0)).toMatchObject({ owner: "acme", name: "web", number: 7 });
      expect(list.candidates.map((candidate) => [candidate.login, candidate.isRequested])).toEqual([
        ["octocat", true],
        ["hubot", false],
      ]);
    }),
  );

  it.effect("puts labels on by posting to the issue's own collection, all at once", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.setLabels({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        labels: ["bug", "size:XL"],
        applied: true,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(callAt(0)).toMatchObject({
        kind: "rest",
        method: "POST",
        path: "repos/acme/web/issues/7/labels",
        body: { labels: ["bug", "size:XL"] },
      });
    }),
  );

  it.effect("takes labels off one at a time, naming each in the path encoded", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.setLabels({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        labels: ["good first issue", "area/web"],
        applied: false,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      expect(callAt(0)).toMatchObject({
        method: "DELETE",
        path: "repos/acme/web/issues/7/labels/good%20first%20issue",
      });
      expect(callAt(1)).toMatchObject({
        method: "DELETE",
        path: "repos/acme/web/issues/7/labels/area%2Fweb",
      });
    }),
  );

  it.effect("reads every page of viewed files, and says so when there are too many", () =>
    Effect.gen(function* () {
      const page = (index: number, hasNextPage: boolean) =>
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    files: {
                      pageInfo: { hasNextPage, endCursor: `cursor-${index}` },
                      nodes: [
                        { path: `src/file${index}.ts`, viewerViewedState: "VIEWED" },
                        { path: `src/other${index}.ts`, viewerViewedState: "UNVIEWED" },
                      ],
                    },
                  },
                },
              },
            }),
          ),
        );
      mockedExecute
        .mockReturnValueOnce(page(0, true))
        .mockReturnValueOnce(page(1, true))
        .mockReturnValueOnce(page(2, false));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const viewed = yield* cli.getPullRequestFilesViewed({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 3);
      expect([varsAt(0)["after"], varsAt(1)["after"], varsAt(2)["after"]]).toEqual([
        undefined,
        "cursor-0",
        "cursor-1",
      ]);
      assert.isFalse(viewed.truncated);
      expect(viewed.files.map((file) => [file.path, file.state])).toEqual([
        ["src/file0.ts", "viewed"],
        ["src/other0.ts", "unviewed"],
        ["src/file1.ts", "viewed"],
        ["src/other1.ts", "unviewed"],
        ["src/file2.ts", "viewed"],
        ["src/other2.ts", "unviewed"],
      ]);
    }),
  );

  it.effect("stops paging viewed files rather than following a change without end", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    files: {
                      pageInfo: { hasNextPage: true, endCursor: "cursor" },
                      nodes: [{ path: "src/file.ts", viewerViewedState: "VIEWED" }],
                    },
                  },
                },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const viewed = yield* cli.getPullRequestFilesViewed({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      assert.isTrue(viewed.truncated);
    }),
  );

  it.effect("clears and restores a burst of files in one request", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(encodeJson({ data: { repository: { pullRequest: { id: "PR_1" } } } })),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.setPullRequestFilesViewed({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 23,
        files: [
          { path: "src/a.ts", viewed: true },
          { path: "src/b.ts", viewed: false },
        ],
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      expect(queryAt(1)).toContain("_0_markFileAsViewed:markFileAsViewed(");
      expect(queryAt(1)).toContain("_1_unmarkFileAsViewed:unmarkFileAsViewed(");
      // Each path travels as a variable, so none can be read as part of the document.
      expect(varsAt(1)).toEqual({
        _0_pullRequestId: "PR_1",
        _0_path: "src/a.ts",
        _0_viewed: true,
        _1_pullRequestId: "PR_1",
        _1_path: "src/b.ts",
        _1_viewed: false,
      });
    }),
  );

  it.effect("asks the host nothing when nothing was pressed", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.setPullRequestFilesViewed({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        files: [],
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("looks a pull request's node id up once, however often it is written to", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(encodeJson({ data: { repository: { pullRequest: { id: "PR_24" } } } })),
          ),
        )
        .mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const pullRequest = { cwd: "/w", repository: "acme/web", host: "github.com", number: 24 };

      yield* cli.setPullRequestFilesViewed({
        ...pullRequest,
        files: [{ path: "src/a.ts", viewed: true }],
      });
      yield* cli.setPullRequestFilesViewed({
        ...pullRequest,
        files: [{ path: "src/b.ts", viewed: true }],
      });
      yield* cli.updatePullRequest({ ...pullRequest, title: "Ticked through" });

      assert.strictEqual(mockedExecute.mock.calls.length, 4);
      expect(varsAt(0)).toEqual({ owner: "acme", name: "web", number: 24 });
      expect(
        [1, 2, 3].map(
          (index) => varsAt(index)["pullRequestId"] ?? varsAt(index)["_0_pullRequestId"],
        ),
      ).toEqual(["PR_24", "PR_24", "PR_24"]);
    }),
  );

  it.effect("does not remember a node id lookup that failed", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output('{"message":"not found"}')))
        .mockReturnValueOnce(
          Effect.succeed(
            output(encodeJson({ data: { repository: { pullRequest: { id: "PR_25" } } } })),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const write = () =>
        cli.setPullRequestFilesViewed({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 25,
          files: [{ path: "src/a.ts", viewed: true }],
        });

      const error = yield* Effect.flip(write());
      assert.strictEqual(error._tag, "GitHubPullRequestReadError");

      yield* write();

      assert.strictEqual(mockedExecute.mock.calls.length, 3);
      expect(varsAt(2)["_0_pullRequestId"]).toEqual("PR_25");
    }),
  );
  it.effect("keeps the pull request being ticked through, not the one looked up first", () =>
    Effect.gen(function* () {
      const HOT = 9_000;
      const lookupsOf = new Map<number, number>();
      mockedExecute.mockImplementation((input) => {
        if (input.kind !== "graphql" || input.operationName !== NODE_ID_QUERY) {
          return Effect.succeed(output("{}"));
        }
        const number = Number(input.variables?.["number"]);
        lookupsOf.set(number, (lookupsOf.get(number) ?? 0) + 1);
        return Effect.succeed(
          output(encodeJson({ data: { repository: { pullRequest: { id: `PR_${number}` } } } })),
        );
      });
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const tick = (number: number) =>
        cli.setPullRequestFilesViewed({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number,
          files: [{ path: "src/a.ts", viewed: true }],
        });

      yield* tick(HOT);
      for (let filled = 0; filled < GitHubPullRequestApi.NODE_ID_CACHE_CAPACITY; filled += 1) {
        yield* tick(HOT + 1 + filled);
        yield* tick(HOT);
      }

      assert.strictEqual(lookupsOf.get(HOT), 1);
    }),
  );
});
