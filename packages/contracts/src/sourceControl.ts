import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { VcsDriverKind } from "./vcs.ts";

export const SourceControlProviderKind = Schema.Literals([
  "github",
  "gitlab",
  "azure-devops",
  "bitbucket",
  "unknown",
]);
export type SourceControlProviderKind = typeof SourceControlProviderKind.Type;

export const SourceControlProviderInfo = Schema.Struct({
  kind: SourceControlProviderKind,
  name: TrimmedNonEmptyString,
  baseUrl: Schema.String,
});
export type SourceControlProviderInfo = typeof SourceControlProviderInfo.Type;

export const ChangeRequestState = Schema.Literals(["open", "closed", "merged"]);
export type ChangeRequestState = typeof ChangeRequestState.Type;

export const ChangeRequest = Schema.Struct({
  provider: SourceControlProviderKind,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  state: ChangeRequestState,
  updatedAt: Schema.Option(Schema.DateTimeUtc),
  isCrossRepository: Schema.optional(Schema.Boolean),
  headRepositoryNameWithOwner: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  headRepositoryOwnerLogin: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type ChangeRequest = typeof ChangeRequest.Type;

export const SourceControlIssueState = Schema.Literals(["open", "closed"]);
export type SourceControlIssueState = typeof SourceControlIssueState.Type;

/** One row in the issue picker. Kept small so listing a repo stays cheap. */
export const SourceControlIssueSummary = Schema.Struct({
  provider: SourceControlProviderKind,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  state: SourceControlIssueState,
  labels: Schema.Array(TrimmedNonEmptyString),
  updatedAt: Schema.Option(Schema.DateTimeUtc),
});
export type SourceControlIssueSummary = typeof SourceControlIssueSummary.Type;

export const SourceControlIssueComment = Schema.Struct({
  author: Schema.NullOr(TrimmedNonEmptyString),
  body: Schema.String,
});
export type SourceControlIssueComment = typeof SourceControlIssueComment.Type;

/** The full issue, fetched only once the user picks one out of the list. */
export const SourceControlIssue = Schema.Struct({
  provider: SourceControlProviderKind,
  repository: Schema.NullOr(TrimmedNonEmptyString),
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  state: SourceControlIssueState,
  author: Schema.NullOr(TrimmedNonEmptyString),
  body: Schema.String,
  comments: Schema.Array(SourceControlIssueComment),
});
export type SourceControlIssue = typeof SourceControlIssue.Type;

export const SourceControlListIssuesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  limit: Schema.optional(PositiveInt),
});
export type SourceControlListIssuesInput = typeof SourceControlListIssuesInput.Type;

export const SourceControlListIssuesResult = Schema.Struct({
  provider: SourceControlProviderKind,
  issues: Schema.Array(SourceControlIssueSummary),
});
export type SourceControlListIssuesResult = typeof SourceControlListIssuesResult.Type;

export const SourceControlGetIssueInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type SourceControlGetIssueInput = typeof SourceControlGetIssueInput.Type;

/** One `#123` or `owner/repo#123` from a body, named in full by the time it is asked about. */
export const SourceControlReference = Schema.Struct({
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type SourceControlReference = typeof SourceControlReference.Type;

export const SourceControlReferenceKind = Schema.Literals(["issue", "pull-request"]);
export type SourceControlReferenceKind = typeof SourceControlReferenceKind.Type;

/** A pull request's `draft` is its own state here, since that is what the badge shows. */
export const SourceControlReferenceState = Schema.Literals(["open", "draft", "closed", "merged"]);
export type SourceControlReferenceState = typeof SourceControlReferenceState.Type;

/**
 * What a reference turned out to be. A null `kind` is the host saying it has nothing under that
 * number — deleted, never there, or private, which it deliberately does not tell apart. One the
 * host never answered about is absent entirely: not knowing is not knowing there is nothing.
 */
export const SourceControlResolvedReference = Schema.Struct({
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  kind: Schema.NullOr(SourceControlReferenceKind),
  title: Schema.NullOr(TrimmedNonEmptyString),
  state: Schema.NullOr(SourceControlReferenceState),
  url: Schema.NullOr(Schema.String),
});
export type SourceControlResolvedReference = typeof SourceControlResolvedReference.Type;

export const SourceControlResolveReferencesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  references: Schema.Array(SourceControlReference),
});
export type SourceControlResolveReferencesInput = typeof SourceControlResolveReferencesInput.Type;

export const SourceControlResolveReferencesResult = Schema.Struct({
  provider: SourceControlProviderKind,
  /** The host these answers came from, named by the checkout rather than the caller. */
  host: TrimmedNonEmptyString,
  references: Schema.Array(SourceControlResolvedReference),
});
export type SourceControlResolveReferencesResult = typeof SourceControlResolveReferencesResult.Type;

export const SourceControlRepositoryCloneUrls = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
  /** Repository this one was forked from, when the provider reports a parent. */
  parentNameWithOwner: Schema.optional(TrimmedNonEmptyString),
});
export type SourceControlRepositoryCloneUrls = typeof SourceControlRepositoryCloneUrls.Type;

export const SourceControlRepositoryVisibility = Schema.Literals(["private", "public"]);
export type SourceControlRepositoryVisibility = typeof SourceControlRepositoryVisibility.Type;

export const SourceControlCloneProtocol = Schema.Literals(["auto", "ssh", "https"]);
export type SourceControlCloneProtocol = typeof SourceControlCloneProtocol.Type;

export const SourceControlRepositoryInfo = Schema.Struct({
  provider: SourceControlProviderKind,
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
  /** Repository this one was forked from, when the provider reports a parent. */
  parentNameWithOwner: Schema.optional(TrimmedNonEmptyString),
});
export type SourceControlRepositoryInfo = typeof SourceControlRepositoryInfo.Type;

export const SourceControlRepositoryLookupInput = Schema.Struct({
  provider: SourceControlProviderKind,
  repository: TrimmedNonEmptyString,
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type SourceControlRepositoryLookupInput = typeof SourceControlRepositoryLookupInput.Type;

/**
 * Which repository a fork clone should treat as its default: the repository
 * that was cloned, or the one it was forked from. Mirrors the choice
 * `gh repo set-default` writes, and only applies when the clone is a fork.
 * Omitted means `parent`, which is what `gh repo clone` picks for a fork.
 */
export const SourceControlCloneDefaultRepository = Schema.Literals(["cloned", "parent"]);
export type SourceControlCloneDefaultRepository = typeof SourceControlCloneDefaultRepository.Type;

export const SourceControlCloneRepositoryInput = Schema.Struct({
  provider: Schema.optional(SourceControlProviderKind),
  repository: Schema.optional(TrimmedNonEmptyString),
  remoteUrl: Schema.optional(TrimmedNonEmptyString),
  destinationPath: TrimmedNonEmptyString,
  protocol: Schema.optional(SourceControlCloneProtocol),
  defaultRepository: Schema.optional(SourceControlCloneDefaultRepository),
});
export type SourceControlCloneRepositoryInput = typeof SourceControlCloneRepositoryInput.Type;

export const SourceControlUpstreamRemote = Schema.Struct({
  remoteName: TrimmedNonEmptyString,
  nameWithOwner: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
});
export type SourceControlUpstreamRemote = typeof SourceControlUpstreamRemote.Type;

export const SourceControlCloneRepositoryResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  repository: Schema.NullOr(SourceControlRepositoryInfo),
  /** Present when the clone was a fork and its parent was wired up as a remote. */
  upstream: Schema.optional(SourceControlUpstreamRemote),
});
export type SourceControlCloneRepositoryResult = typeof SourceControlCloneRepositoryResult.Type;

/**
 * One candidate for a project's default repository. `nameWithOwner` is derived
 * from the remote URL, so listing candidates never needs a provider CLI call.
 */
export const SourceControlDefaultRepositoryRemote = Schema.Struct({
  remoteName: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  nameWithOwner: Schema.NullOr(TrimmedNonEmptyString),
  provider: SourceControlProviderKind,
});
export type SourceControlDefaultRepositoryRemote = typeof SourceControlDefaultRepositoryRemote.Type;

export const SourceControlDefaultRepositoryState = Schema.Struct({
  remotes: Schema.Array(SourceControlDefaultRepositoryRemote),
  /** Remote currently pinned as the default, or null when nothing is pinned. */
  defaultRemoteName: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * Repository the pin names when it is not the pinned remote's own — what
   * `gh repo set-default` writes when the default is reachable through a remote
   * but is not that remote's repository, as for a fork cloned without upstream.
   */
  defaultRepositoryPath: Schema.optional(TrimmedNonEmptyString),
});
export type SourceControlDefaultRepositoryState = typeof SourceControlDefaultRepositoryState.Type;

export const SourceControlGetDefaultRepositoryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type SourceControlGetDefaultRepositoryInput =
  typeof SourceControlGetDefaultRepositoryInput.Type;

export const SourceControlSetDefaultRepositoryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  /** Null clears the pin, the way `gh repo set-default --unset` does. */
  remoteName: Schema.NullOr(TrimmedNonEmptyString),
});
export type SourceControlSetDefaultRepositoryInput =
  typeof SourceControlSetDefaultRepositoryInput.Type;

export const SourceControlPublishRepositoryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  provider: SourceControlProviderKind,
  repository: TrimmedNonEmptyString,
  visibility: SourceControlRepositoryVisibility,
  remoteName: Schema.optional(TrimmedNonEmptyString),
  protocol: Schema.optional(SourceControlCloneProtocol),
});
export type SourceControlPublishRepositoryInput = typeof SourceControlPublishRepositoryInput.Type;

export const SourceControlPublishStatus = Schema.Literals(["pushed", "remote_added"]);
export type SourceControlPublishStatus = typeof SourceControlPublishStatus.Type;

export const SourceControlPublishRepositoryResult = Schema.Struct({
  repository: SourceControlRepositoryInfo,
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  upstreamBranch: Schema.optional(TrimmedNonEmptyString),
  status: SourceControlPublishStatus,
});
export type SourceControlPublishRepositoryResult = typeof SourceControlPublishRepositoryResult.Type;

export const SourceControlDiscoveryStatus = Schema.Literals(["available", "missing"]);
export type SourceControlDiscoveryStatus = typeof SourceControlDiscoveryStatus.Type;

export const SourceControlProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type SourceControlProviderAuthStatus = typeof SourceControlProviderAuthStatus.Type;

export const SourceControlProviderAuth = Schema.Struct({
  status: SourceControlProviderAuthStatus,
  account: Schema.Option(TrimmedNonEmptyString),
  host: Schema.Option(TrimmedNonEmptyString),
  detail: Schema.Option(TrimmedNonEmptyString),
});
export type SourceControlProviderAuth = typeof SourceControlProviderAuth.Type;

const SourceControlDiscoverySharedFields = {
  label: TrimmedNonEmptyString,
  executable: Schema.optional(TrimmedNonEmptyString),
  status: SourceControlDiscoveryStatus,
  version: Schema.Option(TrimmedNonEmptyString),
  installHint: TrimmedNonEmptyString,
  detail: Schema.Option(TrimmedNonEmptyString),
} as const;

export const VcsDiscoveryItem = Schema.Struct({
  kind: VcsDriverKind,
  implemented: Schema.Boolean,
  ...SourceControlDiscoverySharedFields,
});
export type VcsDiscoveryItem = typeof VcsDiscoveryItem.Type;

export const SourceControlProviderDiscoveryItem = Schema.Struct({
  kind: SourceControlProviderKind,
  ...SourceControlDiscoverySharedFields,
  auth: SourceControlProviderAuth,
});
export type SourceControlProviderDiscoveryItem = typeof SourceControlProviderDiscoveryItem.Type;

export const SourceControlDiscoveryResult = Schema.Struct({
  versionControlSystems: Schema.Array(VcsDiscoveryItem),
  sourceControlProviders: Schema.Array(SourceControlProviderDiscoveryItem),
});
export type SourceControlDiscoveryResult = typeof SourceControlDiscoveryResult.Type;

export class SourceControlProviderError extends Schema.TaggedErrorClass<SourceControlProviderError>()(
  "SourceControlProviderError",
  {
    provider: SourceControlProviderKind,
    operation: Schema.String,
    cwd: Schema.String,
    command: Schema.optional(Schema.String),
    repository: Schema.optional(Schema.String),
    reference: Schema.optional(Schema.String),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Source control provider ${this.provider} failed in ${this.operation}: ${this.detail}`;
  }
}

export class SourceControlRepositoryError extends Schema.TaggedErrorClass<SourceControlRepositoryError>()(
  "SourceControlRepositoryError",
  {
    provider: SourceControlProviderKind,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Source control repository operation ${this.operation} failed for ${this.provider}: ${this.detail}`;
  }
}
