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
  labels: Schema.optional(Schema.NullOr(Schema.Array(GitHubIssueLabelSchema))),
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
  comments: Schema.optional(Schema.NullOr(Schema.Array(GitHubIssueCommentSchema))),
});

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeGitHubIssueState(state: string | null | undefined): "open" | "closed" {
  return state?.trim().toUpperCase() === "CLOSED" ? "closed" : "open";
}

/**
 * `gh issue view` does not report the repository, but every issue URL carries
 * it (`https://github.com/owner/repo/issues/123`). Reading it back here keeps
 * the issue context block self-describing without a second `gh` call.
 */
export function parseRepositoryNameFromIssueUrl(url: string): string | null {
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
  for (const label of raw.labels ?? []) {
    const name = trimOptionalString(label.name);
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
): NormalizedGitHubIssue {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: normalizeGitHubIssueState(raw.state),
    repository: parseRepositoryNameFromIssueUrl(raw.url),
    author: trimOptionalString(raw.author?.login),
    body: raw.body?.trim() ?? "",
    comments: (raw.comments ?? []).map((comment) => ({
      author: trimOptionalString(comment.author?.login),
      body: comment.body?.trim() ?? "",
    })),
  };
}

const decodeGitHubIssueArray = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeGitHubIssueRecord = decodeJsonResult(GitHubIssueSchema);
const decodeGitHubIssueSummaryEntry = Schema.decodeUnknownExit(GitHubIssueSummarySchema);

/**
 * Individually-invalid rows are skipped rather than failing the whole list, so
 * a version-drifted `gh` can never blank out the issue picker.
 */
export function decodeGitHubIssueListJson(
  raw: string,
): Result.Result<ReadonlyArray<NormalizedGitHubIssueSummary>, Cause.Cause<Schema.SchemaError>> {
  const result = decodeGitHubIssueArray(raw);
  if (Result.isSuccess(result)) {
    const issues: Array<NormalizedGitHubIssueSummary> = [];
    for (const entry of result.success) {
      const decodedEntry = decodeGitHubIssueSummaryEntry(entry);
      if (Exit.isFailure(decodedEntry)) {
        continue;
      }
      issues.push(normalizeGitHubIssueSummary(decodedEntry.value));
    }
    return Result.succeed(issues);
  }
  return Result.fail(result.failure);
}

export function decodeGitHubIssueJson(
  raw: string,
): Result.Result<NormalizedGitHubIssue, Cause.Cause<Schema.SchemaError>> {
  const result = decodeGitHubIssueRecord(raw);
  if (Result.isSuccess(result)) {
    return Result.succeed(normalizeGitHubIssue(result.success));
  }
  return Result.fail(result.failure);
}
