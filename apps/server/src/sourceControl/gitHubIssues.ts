import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

export interface NormalizedGitHubIssueSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: "open" | "closed";
  readonly labels: ReadonlyArray<string>;
  readonly updatedAt: Option.Option<DateTime.Utc>;
}

export interface NormalizedGitHubIssueComment {
  readonly author: string | null;
  readonly body: string;
}

export interface NormalizedGitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: "open" | "closed";
  readonly repository: string | null;
  readonly author: string | null;
  readonly body: string;
  readonly comments: ReadonlyArray<NormalizedGitHubIssueComment>;
}

const GitHubActorSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubIssueLabelSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubIssueSummarySchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  labels: Schema.optional(
    Schema.NullOr(Schema.Struct({ nodes: Schema.Array(Schema.NullOr(GitHubIssueLabelSchema)) })),
  ),
  updatedAt: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
});

const GitHubIssueCommentSchema = Schema.Struct({
  author: Schema.optional(Schema.NullOr(GitHubActorSchema)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubIssueSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(GitHubActorSchema)),
});

const GitHubIssueCommentPageSchema = Schema.Struct({
  pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
  nodes: Schema.Array(Schema.NullOr(GitHubIssueCommentSchema)),
});

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeGitHubIssueState(state: string | null | undefined): "open" | "closed" {
  return state?.trim().toUpperCase() === "CLOSED" ? "closed" : "open";
}

/**
 * Every issue URL carries its repository (`https://github.com/owner/repo/issues/123`). Reading it
 * back here keeps the issue context block self-describing without another request.
 */
function parseRepositoryNameFromIssueUrl(url: string): string | null {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    const owner = segments[0];
    const repository = segments[1];
    return owner && repository ? `${owner}/${repository}` : null;
  } catch {
    return null;
  }
}

function normalizeGitHubIssueSummary(
  raw: Schema.Schema.Type<typeof GitHubIssueSummarySchema>,
): NormalizedGitHubIssueSummary {
  const labels: Array<string> = [];
  for (const label of raw.labels?.nodes ?? []) {
    const name = trimOptionalString(label?.name);
    if (name) {
      labels.push(name);
    }
  }

  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: normalizeGitHubIssueState(raw.state),
    labels,
    updatedAt: raw.updatedAt ?? Option.none(),
  };
}

function normalizeGitHubIssue(
  raw: Schema.Schema.Type<typeof GitHubIssueSchema>,
  comments: ReadonlyArray<Schema.Schema.Type<typeof GitHubIssueCommentSchema>>,
): NormalizedGitHubIssue {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: normalizeGitHubIssueState(raw.state),
    repository: parseRepositoryNameFromIssueUrl(raw.url),
    author: trimOptionalString(raw.author?.login),
    body: raw.body?.trim() ?? "",
    comments: comments.map((comment) => ({
      author: trimOptionalString(comment.author?.login),
      body: comment.body?.trim() ?? "",
    })),
  };
}

/** The open issues `gh issue list` shows, newest first. */
export const GITHUB_ISSUE_LIST_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, states: [OPEN], orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { number title url state updatedAt labels(first: 20) { nodes { name } } }
    }
  }
}`;

/** One issue and a page of its comments; later pages repeat the cheap issue fields. */
export const GITHUB_ISSUE_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number title url state body author { login }
      comments(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { author { login } body }
      }
    }
  }
}`;

const decodeGitHubIssueList = decodeJsonResult(
  Schema.Struct({
    data: Schema.Struct({
      repository: Schema.NullOr(
        Schema.Struct({ issues: Schema.Struct({ nodes: Schema.Array(Schema.Unknown) }) }),
      ),
    }),
  }),
);
const decodeGitHubIssueRecord = decodeJsonResult(
  Schema.Struct({
    data: Schema.Struct({
      repository: Schema.NullOr(
        Schema.Struct({
          issue: Schema.NullOr(
            Schema.Struct({ ...GitHubIssueSchema.fields, comments: GitHubIssueCommentPageSchema }),
          ),
        }),
      ),
    }),
  }),
);
const decodeGitHubIssueSummaryEntry = Schema.decodeUnknownExit(GitHubIssueSummarySchema);

/**
 * Individually-invalid rows are skipped rather than failing the whole list, so one malformed
 * issue can never blank out the issue picker.
 */
export function decodeGitHubIssueListJson(
  raw: string,
): Result.Result<ReadonlyArray<NormalizedGitHubIssueSummary>, Cause.Cause<Schema.SchemaError>> {
  const result = decodeGitHubIssueList(raw);
  if (Result.isFailure(result)) return Result.fail(result.failure);
  const issues: Array<NormalizedGitHubIssueSummary> = [];
  for (const entry of result.success.data.repository?.issues.nodes ?? []) {
    const decodedEntry = decodeGitHubIssueSummaryEntry(entry);
    if (Exit.isFailure(decodedEntry)) continue;
    issues.push(normalizeGitHubIssueSummary(decodedEntry.value));
  }
  return Result.succeed(issues);
}

/** One page of an issue read; null where the repository has no issue under that number. */
export interface GitHubIssuePage {
  readonly issue: Schema.Schema.Type<typeof GitHubIssueSchema>;
  readonly comments: ReadonlyArray<Schema.Schema.Type<typeof GitHubIssueCommentSchema>>;
  readonly nextCursor: string | null;
}

export function decodeGitHubIssuePageJson(
  raw: string,
): Result.Result<GitHubIssuePage | null, Cause.Cause<Schema.SchemaError>> {
  const result = decodeGitHubIssueRecord(raw);
  if (Result.isFailure(result)) return Result.fail(result.failure);
  const issue = result.success.data.repository?.issue;
  if (issue === null || issue === undefined) return Result.succeed(null);
  const { comments, ...fields } = issue;
  return Result.succeed({
    issue: fields,
    comments: comments.nodes.flatMap((comment) => (comment === null ? [] : [comment])),
    nextCursor: comments.pageInfo.hasNextPage ? comments.pageInfo.endCursor : null,
  });
}

/** The issue a first page described, with every comment the pages carried, in order. */
export function gitHubIssueFromPages(
  first: GitHubIssuePage,
  comments: GitHubIssuePage["comments"],
): NormalizedGitHubIssue {
  return normalizeGitHubIssue(first.issue, comments);
}
