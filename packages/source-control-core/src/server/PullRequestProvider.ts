import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  PullRequestStackMembership,
  PullRequestAction,
  PullRequestStackHead,
  PullRequestActor,
  PullRequestBaseComparison,
  PullRequestCapabilities,
  PullRequestChecksState,
  PullRequestCheck,
  PullRequestChecks,
  PullRequestComment,
  PullRequestDeployment,
  PullRequestFileViewed,
  PullRequestCommit,
  PullRequestInvolvement,
  PullRequestLabel,
  PullRequestListFilters,
  PullRequestListState,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestMergeReadiness,
  PullRequestMergeability,
  PullRequestOmittedFileStat,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewCommentDraft,
  PullRequestReviewDecision,
  PullRequestReviewThread,
  PullRequestThreadCommentsResult,
  PullRequestReviewVerdict,
  PullRequestReviewerCandidateList,
  PullRequestReviewerKind,
  PullRequestLabelCandidateList,
  PullRequestState,
  PullRequestPreview,
  PullRequestUpdateMethod,
  PullRequestViewerPermissions,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { SourceControlProviderKind as SourceControlProviderKindSchema } from "@t3tools/contracts";

export class PullRequestProviderError extends Schema.TaggedError<PullRequestProviderError>()(
  "PullRequestProviderError",
  {
    provider: SourceControlProviderKindSchema,
    operation: Schema.String,
    reason: Schema.Literals([
      "missing-tool",
      "unauthenticated",
      "rate-limited",
      "not-found",
      "failed",
    ]),
    detail: Schema.String,
    retryAt: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.provider} failed in ${this.operation}: ${this.detail}`;
  }
}

export interface ProviderChangeRequestWatchFingerprint {
  readonly status: string;
  readonly remarks: string;
}

export interface PullRequestProviderFailure {
  readonly reason: PullRequestProviderError["reason"];
  readonly retryAt?: number | undefined;
}

export interface ProviderChangeRequest {
  readonly autoMergeEnabled?: boolean;
  readonly inMergeQueue?: boolean;
  readonly stack?: PullRequestStackMembership;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  readonly additions: number;
  readonly deletions: number;
  readonly createdAt: string;
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly updatedAt: string;
  readonly reviewRequestLogins: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<PullRequestLabel>;
  readonly reviewDecision?: PullRequestReviewDecision | null | undefined;
  readonly checksState?: PullRequestChecksState | null | undefined;
}

export interface ProviderChangeRequestSummary {
  readonly autoMergeEnabled?: boolean;
  readonly inMergeQueue?: boolean;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft?: boolean;
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly updatedAt: string;
  readonly author?: PullRequestActor | null | undefined;
  readonly additions?: number | undefined;
  readonly deletions?: number | undefined;
  readonly changedFiles?: number | undefined;
  readonly reviewDecision?: PullRequestReviewDecision | null | undefined;
  readonly checksState?: PullRequestChecksState | null | undefined;
  readonly mergeability?: PullRequestMergeability | undefined;
  /** Null means no stack; absent means not requested. */
  readonly stack?: PullRequestStackMembership | null | undefined;
}

export interface ProviderChangeRequestStackLayer {
  readonly title?: string;
  readonly isDraft?: boolean;
  readonly headSha?: string;
  readonly number: number;
  readonly headBranch: string;
  readonly state: PullRequestState;
}

export interface ProviderChangeRequestStack {
  readonly id: string;
  readonly number: number;
  readonly url: string;
  readonly base: string;
  readonly layers: ReadonlyArray<ProviderChangeRequestStackLayer>;
}

export interface ProviderChangeRequestPage {
  readonly items: ReadonlyArray<ProviderChangeRequest>;
  readonly truncated: boolean;
  /** Offset-paged hosts must include malformed raw rows in their advance count. */
  readonly cursorAdvance?: number;
  /**
   * Where a host that can only page from the top carries on: an opaque position past the last
   * row delivered, handed back as the cursor's `resumeAfter`. Unlike a count of rows it survives
   * rows above it closing between reads.
   */
  readonly resumeAfter?: string;
  readonly continues: boolean;
}

export interface ProviderListCursor {
  /** Inclusive boundary: equal-time rows can span pages and must not be skipped. */
  readonly updatedBefore: string;
  readonly delivered: number;
  /**
   * Rows already handed over at `updatedBefore`. Timestamp-paged hosts can exclude these before
   * applying their limit so a full page of tied updates does not repeat the same prefix.
   */
  readonly seenAt?: ReadonlyArray<number> | undefined;
  readonly resumeAfter?: string | undefined;
}

export interface ProviderBatchedChangeRequest extends ProviderChangeRequest {
  readonly repository: string;
}

export interface ProviderBatchedChangeRequestPage {
  readonly items: ReadonlyArray<ProviderBatchedChangeRequest>;
  readonly truncated: boolean;
  /**
   * Repositories asked about that the page cannot vouch for: its silence about them may be an
   * omission rather than an empty answer, so the caller reads each on its own.
   */
  readonly unresolved?: ReadonlyArray<string>;
}

export interface ProviderChangeRequestStat {
  readonly repository: string;
  readonly number: number;
  readonly additions: number;
  readonly deletions: number;
}

export interface ProviderChangeRequestDetail extends ProviderChangeRequest {
  readonly body: string;
  readonly changedFiles: number;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly reviewers: ReadonlyArray<PullRequestActor>;
  readonly checks: ReadonlyArray<PullRequestCheck>;
  readonly deployments?: ReadonlyArray<PullRequestDeployment>;
  readonly deploymentsTruncated?: boolean;
  readonly mergeCapabilities: PullRequestMergeCapabilities;
  readonly viewerPermissions: PullRequestViewerPermissions;
  /** Absent from a host that cannot apply repository policy to its merge verdict. */
  readonly mergeReadiness?: PullRequestMergeReadiness;
  /** Whether repository rules require the head branch to include the latest base commit. */
  readonly requiresUpToDateBranch?: boolean;
  readonly baseComparison?: PullRequestBaseComparison;
  readonly behindBy?: number;
  readonly autoMergeEnabled?: boolean;
  readonly inMergeQueue?: boolean;
  readonly autoMergeMethod?: PullRequestMergeMethod;
  readonly workflowApprovalsRequired?: number;
  /** Only from a host whose `runAction` honours `expectedHeadSha`. */
  readonly headSha?: string;
}

export interface ProviderChangeRequestActivity {
  readonly author?: PullRequestActor | null;
  readonly reviewers?: ReadonlyArray<PullRequestActor>;
  readonly comments: ReadonlyArray<PullRequestComment>;
  readonly commentCount: number;
  readonly commentsTruncated: boolean;
  readonly reviewThreadsTruncated?: boolean;
  readonly reviewThreads: ReadonlyArray<PullRequestReviewThread>;
  readonly commits: ReadonlyArray<PullRequestCommit>;
  readonly reactions?: ReadonlyArray<PullRequestReaction>;
}

export interface ProviderDiffSlice {
  readonly patch: string;
  /** Content was omitted within this slice. */
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly omittedFileStats?: ReadonlyArray<PullRequestOmittedFileStat>;
}

export interface ProviderDiffFileContents {
  readonly oldContents: string;
  readonly newContents: string;
}

/** A bounded repository file referenced by a pull request, ready for the server to proxy. */
export interface ProviderPullRequestFile {
  readonly url: string;
  readonly size: number;
}

export interface ProviderFilesViewed {
  readonly files: ReadonlyArray<PullRequestFileViewed>;
  /** More files exist; missing entries are unknown, not "unviewed". */
  readonly truncated: boolean;
}

export interface ProviderFileStats {
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
  /** The host has more files than were read. */
  readonly truncated: boolean;
}

/**
 * Opaque strings, compared only against one another, where the empty string is the answer for a
 * file the change request deletes rather than a gap. A path is absent only where the read could
 * not say, so a provider converts its host's own absences on the way here.
 */
export interface ProviderFileRevisions {
  readonly revisions: ReadonlyMap<string, string>;
  /** All revisions were read and can be reused for other paths. */
  readonly complete?: boolean;
}

/** A CI workflow run as a watch sees it. */
export interface ProviderWorkflowRun {
  /** The workflow and run number, such as `CI #812`. */
  readonly name: string;
  readonly url: string;
  /** True once the run finished, whatever its conclusion. */
  readonly completed: boolean;
  /** The host's word for how it ended, such as "success" or "failure"; null while running. */
  readonly conclusion: string | null;
  readonly headBranch: string | null;
  readonly headSha: string;
  readonly event: string;
  /**
   * Deployment environments the run waits on that the viewer may approve. Empty unless the run
   * is held for review.
   */
  readonly reviewableEnvironments: ReadonlyArray<{ readonly id: number; readonly name: string }>;
  /** Jobs of the latest attempt that did not succeed or skip; read only once the run completed. */
  readonly failedJobs: ReadonlyArray<{
    readonly name: string;
    readonly conclusion: string | null;
    readonly url: string | null;
  }>;
}

/** Approves or rejects deployment environments a workflow run waits on. */
export interface ProviderWorkflowRunReviewInput {
  readonly cwd: string;
  readonly repository: string;
  readonly host: string;
  readonly runId: number;
  readonly environmentIds: ReadonlyArray<number>;
  readonly state: "approved" | "rejected";
  readonly comment: string;
}

export interface ProviderFilterOptionPage<A> {
  readonly items: ReadonlyArray<A>;
  readonly truncated: boolean;
}

export interface ProviderRepositoryRef {
  readonly cwd: string;
  readonly repository: string;
  readonly host: string;
}

export interface PullRequestProviderApi {
  readonly withVerifiedCredential?: <A, E, R>(
    input: { readonly cwd: string; readonly host: string },
    use: (identity: {
      readonly accountId: string;
      readonly viewer: string;
      readonly credentialFingerprint: string;
    }) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | PullRequestProviderError, R>;
  readonly getRoutingIdentity?: (input: {
    readonly cwd: string;
    readonly host: string;
  }) => Effect.Effect<
    { readonly accountId: string; readonly viewer: string },
    PullRequestProviderError
  >;
  readonly kind: SourceControlProviderKind;
  readonly capabilities: PullRequestCapabilities;
  /**
   * What a reader is told when this host cannot be read on the server: `missing` for no tool or
   * credential, `unauthenticated` for one the host refused. Absent means a generic sentence.
   */
  readonly unavailableRequirement?: {
    readonly missing: string;
    readonly unauthenticated: string;
  };
  readonly mergeMessageRewrite?: (message: string) => string;
  /** Use matching checkout keys instead of `owner/name`. */
  readonly repositoryKey?: (input: { readonly canonicalKey: string }) => string;
  /**
   * Names the repository in every request and authenticates by host, so a change request on the
   * definition's `publicHost` can be read from a project with no checkout of its repository.
   */
  readonly readsPublicHostWithoutCheckout?: boolean;

  readonly getViewer: (input: {
    readonly cwd: string;
    readonly host?: string;
  }) => Effect.Effect<string, PullRequestProviderError>;

  readonly listChangeRequests: (
    input: ProviderRepositoryRef & {
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      /** Hosts may ignore unsupported search; the caller filters returned rows. */
      readonly query?: string | undefined;
      readonly cursor?: ProviderListCursor | undefined;
      /** The caller applies any filters the host ignores. */
      readonly filters?: PullRequestListFilters | undefined;
    },
  ) => Effect.Effect<ProviderChangeRequestPage, PullRequestProviderError>;

  /** Newest `limit` rows total across repositories, under one cursor boundary. */
  readonly listChangeRequestsAcross?: (input: {
    readonly cwd: string;
    readonly host: string;
    readonly repositories: ReadonlyArray<string>;
    readonly state: PullRequestListState;
    readonly involvement: PullRequestInvolvement;
    readonly viewer: string;
    readonly limit: number;
    readonly query?: string | undefined;
    readonly cursor?: ProviderListCursor | undefined;
    readonly filters?: PullRequestListFilters | undefined;
  }) => Effect.Effect<ProviderBatchedChangeRequestPage, PullRequestProviderError>;

  readonly listChangeRequestStats?: (input: {
    readonly cwd: string;
    readonly host: string;
    readonly changeRequests: ReadonlyArray<{
      readonly repository: string;
      readonly number: number;
    }>;
  }) => Effect.Effect<ReadonlyArray<ProviderChangeRequestStat>, PullRequestProviderError>;

  readonly getChangeRequestChecks?: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<Pick<PullRequestChecks, "state" | "checks">, PullRequestProviderError>;

  readonly getChangeRequest: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderChangeRequestDetail, PullRequestProviderError>;

  readonly getChangeRequestPreview?: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<
    Omit<PullRequestPreview, "projectId" | "repository">,
    PullRequestProviderError
  >;

  readonly getChangeRequestSummary?: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderChangeRequestSummary, PullRequestProviderError>;

  /** Null means unknown; an absent method requires full watch reads. */
  readonly getChangeRequestWatchFingerprint?: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderChangeRequestWatchFingerprint | null, PullRequestProviderError>;

  /** A CI workflow run, for watching it. Optional: only GitHub Actions is read. */
  readonly getWorkflowRun?: (
    input: ProviderRepositoryRef & { readonly runId: number },
  ) => Effect.Effect<ProviderWorkflowRun, PullRequestProviderError>;

  /** Optional, like `getWorkflowRun`. */
  readonly reviewWorkflowRun?: (
    input: ProviderWorkflowRunReviewInput,
  ) => Effect.Effect<void, PullRequestProviderError>;

  readonly getChangeRequestStack?: (
    input: ProviderRepositoryRef & { readonly includeDetails?: boolean; readonly number: number },
  ) => Effect.Effect<ProviderChangeRequestStack | null, PullRequestProviderError>;

  readonly getChangeRequestActivity: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderChangeRequestActivity, PullRequestProviderError>;

  readonly getReviewThreadComments?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly threadId: string;
      readonly cursor: string;
    },
  ) => Effect.Effect<PullRequestThreadCommentsResult, PullRequestProviderError>;

  /** Read fresh before writes; client permissions may be stale or bypassed. */
  readonly getViewerPermissions: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly includeUpdateBranch?: boolean;
    },
  ) => Effect.Effect<PullRequestViewerPermissions, PullRequestProviderError>;

  readonly getDiff: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly cursor?: string | undefined;
      readonly commit?: string | undefined;
    },
  ) => Effect.Effect<ProviderDiffSlice, PullRequestProviderError>;

  readonly getDiffFileContents?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly commit?: string | undefined;
      readonly changeType: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
      readonly oldPath: string;
      readonly newPath: string;
    },
  ) => Effect.Effect<ProviderDiffFileContents, PullRequestProviderError>;

  /**
   * A short-lived URL for a repository file at the change request's head. Optional because not
   * every host can exchange its CLI authentication for a file-scoped URL the server can proxy.
   * GitHub uses this for relative images embedded in descriptions.
   */
  readonly getFile?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly path: string;
    },
  ) => Effect.Effect<ProviderPullRequestFile, PullRequestProviderError>;

  readonly getFilesViewed?: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderFilesViewed, PullRequestProviderError>;

  /** Line counts for every changed file. Optional: a host without one shows no breakdown. */
  readonly getFileStats?: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderFileStats, PullRequestProviderError>;

  /**
   * A host with no bulk form is still owed one round trip for the batch rather than one per
   * file, since the point of gathering presses is that the host is asked once.
   */
  readonly setFilesViewed?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly files: ReadonlyArray<{ readonly path: string; readonly viewed: boolean }>;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /** Required for `environment` viewed marks to invalidate them after changes. */
  readonly getFileRevisions?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly paths: ReadonlyArray<string>;
    },
  ) => Effect.Effect<ProviderFileRevisions, PullRequestProviderError>;

  readonly runAction: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly action: PullRequestAction;
      readonly stackNumber?: number;
      readonly expectedStackHeads?: ReadonlyArray<PullRequestStackHead>;
      readonly removeAgentCreditsOnMerge?: boolean;
      readonly mergeMethod?: PullRequestMergeMethod;
      /** Meaningful for `merge` and `enable-auto-merge`; absent merges whatever the head is. */
      readonly expectedHeadSha?: string;
      readonly updateMethod?: PullRequestUpdateMethod;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /** Requires edit capability and at least one field. */
  readonly updateChangeRequest?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly title?: string | undefined;
      readonly body?: string | undefined;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  readonly comment: (
    input: ProviderRepositoryRef & { readonly number: number; readonly body: string },
  ) => Effect.Effect<void, PullRequestProviderError>;

  readonly updateComment?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly commentId: string;
      readonly kind: "issue-comment" | "review-comment";
      readonly body: string;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  readonly submitReview: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /** Exclude the author using host-specific account identities. */
  readonly listReviewerCandidates: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<PullRequestReviewerCandidateList, PullRequestProviderError>;

  readonly setReviewerRequest: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly reviewers: ReadonlyArray<{
        readonly id: string;
        readonly kind: PullRequestReviewerKind;
      }>;
      readonly requested: boolean;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  readonly listLabelCandidates?: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<PullRequestLabelCandidateList, PullRequestProviderError>;

  /**
   * The labels a repository offers, for narrowing a listing by. `query` narrows by name as far as
   * the host can; the caller still matches the answer against it.
   */
  readonly listRepositoryLabels?: (
    input: ProviderRepositoryRef & { readonly query?: string | undefined },
  ) => Effect.Effect<ProviderFilterOptionPage<PullRequestLabel>, PullRequestProviderError>;

  /**
   * People who could have opened a change request in the repository, for narrowing a listing by
   * author. A host that can only search its whole user base answers from that.
   */
  readonly searchRepositoryAuthors?: (
    input: ProviderRepositoryRef & { readonly query?: string | undefined },
  ) => Effect.Effect<ProviderFilterOptionPage<PullRequestActor>, PullRequestProviderError>;

  readonly setLabels?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly labels: ReadonlyArray<string>;
      readonly applied: boolean;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  readonly replyToThread: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly threadId: string;
      readonly body: string;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /** `subjectId` is the conversation's remark ID; absent targets the change request description. */
  readonly setReaction: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly subjectId?: string | undefined;
      readonly content: PullRequestReactionContent;
      readonly reacted: boolean;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  readonly setThreadResolution: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly threadId: string;
      readonly resolved: boolean;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;
}
