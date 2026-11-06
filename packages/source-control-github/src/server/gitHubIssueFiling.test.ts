import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitHubIssueFiling from "./gitHubIssueFiling.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";

const answering = (
  respond: (
    input: GitHubRest.GitHubRestInput,
  ) => Effect.Effect<string, GitHubRequestPolicy.GitHubApiError>,
) =>
  Layer.mock(GitHubRest.GitHubRest)({
    rest: (input) =>
      respond(input).pipe(
        Effect.map((body) => ({
          status: 200,
          headers: {},
          body,
          truncated: false,
          invalidUtf8: false,
        })),
      ),
  });

describe("gitHubIssueFiling", () => {
  it.effect("creates the issue on the given repository and returns its URL", () => {
    const requests: Array<GitHubRest.GitHubRestInput> = [];
    return Effect.gen(function* () {
      const filing = yield* GitHubIssueFiling.make;
      const result = yield* filing.file({
        host: "github.com",
        repository: "owner/repo",
        title: "A title",
        body: "A body",
      });
      expect(result).toEqual({ status: "filed", url: "https://github.com/owner/repo/issues/1" });
      expect(requests).toMatchObject([
        {
          method: "POST",
          path: "repos/owner/repo/issues",
          body: { title: "A title", body: "A body" },
        },
      ]);
    }).pipe(
      Effect.provide(
        answering((input) => {
          requests.push(input);
          return Effect.succeed(
            JSON.stringify({ html_url: "https://github.com/owner/repo/issues/1" }),
          );
        }),
      ),
    );
  });

  it.effect("reports a refusal instead of failing, with GitHub's reason", () =>
    Effect.gen(function* () {
      const filing = yield* GitHubIssueFiling.make;
      const result = yield* filing.file({
        host: "github.com",
        repository: "owner/repo",
        title: "A title",
        body: "A body",
      });
      expect(result).toMatchObject({ status: "refused", reason: expect.stringContaining("403") });
    }).pipe(
      Effect.provide(
        answering(() =>
          Effect.fail(
            new GitHubRequestPolicy.GitHubApiResponseError({
              host: "github.com",
              operation: "fileIssue",
              status: 403,
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("names the signed-in account, or null when there is no usable credential", () =>
    Effect.gen(function* () {
      const filing = yield* GitHubIssueFiling.make;
      expect(yield* filing.account("github.com")).toBe("octocat");
      expect(yield* filing.account("signed-out.example.com")).toBeNull();
    }).pipe(
      Effect.provide(
        answering((input) =>
          input.host === "github.com"
            ? Effect.succeed(JSON.stringify({ login: "octocat" }))
            : Effect.fail(
                new GitHubRequestPolicy.GitHubApiAuthenticationError({
                  host: input.host,
                  operation: input.operation,
                }),
              ),
        ),
      ),
    ),
  );
});
