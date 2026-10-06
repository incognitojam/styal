// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - e2e harness runs plain Node outside any Effect runtime.
/**
 * A fake GitHub API for e2e tests. The server sends its GitHub requests here when started with
 * `T3CODE_TEST_GITHUB_API_URL` set to `url`. It answers the GraphQL issue list and issue reads
 * from `issues`, in the shape `apps/server/src/sourceControl/gitHubIssues.ts` decodes, and
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

export interface FakeGitHubApi {
  readonly url: string;
  readonly requests: () => ReadonlyArray<FakeGitHubApiRequest>;
  readonly stop: () => Promise<void>;
}

const RATE_LIMIT = { cost: 1, limit: 5000, remaining: 4999, resetAt: "2099-01-01T00:00:00Z" };

export async function startFakeGitHubApi(
  issues: ReadonlyArray<FakeGitHubIssue>,
): Promise<FakeGitHubApi> {
  const requests: FakeGitHubApiRequest[] = [];

  const answerGraphQl = (request: FakeGitHubApiRequest): unknown => {
    const query = request.query ?? "";
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
      const answer = request.query === undefined ? undefined : answerGraphQl(request);
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
