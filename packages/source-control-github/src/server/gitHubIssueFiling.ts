import type { SourceControlIssueFiling } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as GitHubRest from "./GitHubRest.ts";

const decodeAccount = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ login: Schema.String })),
);
const decodeIssue = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ html_url: Schema.String })),
);

export const make = Effect.gen(function* () {
  const { rest } = yield* GitHubRest.GitHubRest;
  return {
    account: (host) =>
      rest({ host, operation: "readAuthenticatedUser", path: "user" }).pipe(
        Effect.map((response) => {
          const account = decodeAccount(response.body);
          return account._tag === "Some" ? account.value.login : null;
        }),
        Effect.orElseSucceed(() => null),
      ),
    file: ({ host, repository, title, body }) =>
      rest({
        host,
        operation: "fileIssue",
        method: "POST",
        path: `repos/${repository}/issues`,
        body: { title, body },
      }).pipe(
        Effect.map((response) => {
          const issue = decodeIssue(response.body);
          return issue._tag === "Some"
            ? { status: "filed" as const, url: issue.value.html_url }
            : { status: "refused" as const, reason: "GitHub returned an unexpected response." };
        }),
        Effect.catch((error) =>
          Effect.succeed({ status: "refused" as const, reason: error.message }),
        ),
      ),
  } satisfies SourceControlIssueFiling;
});
