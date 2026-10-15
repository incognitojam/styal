import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import { GraphQL } from "effect/graphql";
import { GitHubIssues, type GitHubIssue } from "./sourceControlProvider.graphql.ts";

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

/** Invalid list rows are skipped without discarding the rest of the issue picker. */
export const LenientGitHubIssues = GraphQL.query(GitHubIssues.name, {
  document: GitHubIssues.document,
  variables: GitHubIssues.variables,
  result: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({ issues: Schema.Struct({ nodes: Schema.Array(Schema.Unknown) }) }),
    ),
  }),
});

export function toGitHubIssueList(result: typeof LenientGitHubIssues.result.Type) {
  return (result.repository?.issues.nodes ?? []).flatMap((entry) => {
    const decoded = decodeGitHubIssueSummaryEntry(entry);
    return Exit.isFailure(decoded) ? [] : [normalizeGitHubIssueSummary(decoded.value)];
  });
}

export function toGitHubIssuePage(result: GitHubIssue.Result): GitHubIssuePage | null {
  const issue = result.repository?.issue;
  if (issue == null) return null;
  return {
    issue,
    comments: (issue.comments.nodes ?? []).flatMap((comment) =>
      comment === null ? [] : [comment],
    ),
    nextCursor: issue.comments.pageInfo.hasNextPage ? issue.comments.pageInfo.endCursor : null,
  };
}

const decodeGitHubIssueSummaryEntry = Schema.decodeUnknownExit(GitHubIssueSummarySchema);

/** One page of an issue read; null where the repository has no issue under that number. */
export interface GitHubIssuePage {
  readonly issue: Schema.Schema.Type<typeof GitHubIssueSchema>;
  readonly comments: ReadonlyArray<Schema.Schema.Type<typeof GitHubIssueCommentSchema>>;
  readonly nextCursor: string | null;
}

/** The issue a first page described, with every comment the pages carried, in order. */
export function gitHubIssueFromPages(
  first: GitHubIssuePage,
  comments: GitHubIssuePage["comments"],
): NormalizedGitHubIssue {
  return normalizeGitHubIssue(first.issue, comments);
}
