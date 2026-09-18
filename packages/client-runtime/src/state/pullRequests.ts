import {
  WS_METHODS,
  type EnvironmentId,
  type PullRequestActor,
  type PullRequestDetail,
  type PullRequestLabel,
  type PullRequestLabelCandidateList,
  type PullRequestDiffInput,
  type PullRequestRef,
  type PullRequestSummary,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentQueryAtomFamily,
} from "./runtime.ts";
import { createPullRequestRouter } from "./pullRequestRouting.ts";
import { PullRequestDiffLoader } from "./pullRequestDiffHttp.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";

export {
  type PullRequestDiffLoadError,
  PullRequestDiffCredentialRejectedError,
  PullRequestDiffLoader,
  pullRequestDiffLoaderLayer,
} from "./pullRequestDiffHttp.ts";

/** @public Required to name the error in consumers' inferred pull request results. */
export class EnvironmentHttpConnectionNotReadyError extends Data.TaggedError(
  "EnvironmentHttpConnectionNotReadyError",
)<{ readonly message: string }> {}

const LINKED_PULL_REQUEST_IDLE_TTL_MS = 5_000;

interface PendingLabelEdit {
  readonly labels: ReadonlyArray<PullRequestLabel>;
  readonly applied: boolean;
}

function applyLabelEdit(labels: PullRequestDetail["labels"], edit: PendingLabelEdit) {
  const names = new Set(edit.labels.map((label) => label.name));
  return edit.applied
    ? [...labels, ...edit.labels.filter((label) => !labels.some(({ name }) => name === label.name))]
    : labels.filter((label) => !names.has(label.name));
}

/** Keep confirmed edits on the same cached reference regardless of input property order. */
function writableQueryFamily<A, E>(
  family: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: PullRequestRef;
  }) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  idleTtlMs = 5 * 60_000,
) {
  const writable = Atom.family((source: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
    Atom.writable(
      (get) => {
        const result = get(source);
        if (result._tag === "Success" && !result.waiting) return result;
        const previous = get.self<AsyncResult.AsyncResult<A, E>>();
        const value = Option.flatMap(previous, AsyncResult.value);
        if (Option.isNone(value)) return result;
        return result._tag === "Failure"
          ? AsyncResult.failureWithPrevious(result.cause, { previous, waiting: result.waiting })
          : AsyncResult.success<A, E>(value.value, result);
      },
      (context, value: AsyncResult.AsyncResult<A, E>) => context.setSelf(value),
      (refresh) => refresh(source),
    ).pipe(Atom.setIdleTTL(idleTtlMs)),
  );
  return ({
    environmentId,
    input: { projectId, host, repository, number },
  }: Parameters<typeof family>[0]) =>
    writable(
      family({
        environmentId,
        input: { projectId, ...(host === undefined ? {} : { host }), repository, number },
      }),
    );
}

/** Restart pre-mutation reads before patching so they cannot restore stale values. */
function updateCached<A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Writable<AsyncResult.AsyncResult<A, E>>,
  update: (value: A) => A,
  refresh = false,
) {
  if (refresh || registry.get(atom).waiting) registry.refresh(atom);
  registry.update(atom, AsyncResult.map(update));
}

function createPullRequestRefreshAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:pull-requests:turn-refreshes",
    tag: WS_METHODS.pullRequestsSubscribeRefreshes,
  });
}

/** Refresh only the live fields a linked thread renders. */
export function createLinkedPullRequestSummaryAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  refreshes = createPullRequestRefreshAtomFamily(runtime),
) {
  const routedRequest = createPullRequestRouter();
  return createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:pull-requests:linked-summary",
    tag: WS_METHODS.pullRequestsSummary,
    execute: (input) => routedRequest(WS_METHODS.pullRequestsSummary, input),
    staleTimeMs: 60_000,
    refreshIntervalMs: 60_000,
    idleTtlMs: LINKED_PULL_REQUEST_IDLE_TTL_MS,
    refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
  });
}

/** The host-native stack a pull request belongs to; null where it is not stacked. */
export function createPullRequestStackAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  refreshes = createPullRequestRefreshAtomFamily(runtime),
) {
  const routedRequest = createPullRequestRouter();
  return createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:pull-requests:stack",
    tag: WS_METHODS.pullRequestsStack,
    execute: (input) => routedRequest(WS_METHODS.pullRequestsStack, input),
    staleTimeMs: 60_000,
    idleTtlMs: LINKED_PULL_REQUEST_IDLE_TTL_MS,
    refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
  });
}

export function pullRequestDetailToVcsStatus(
  detail: PullRequestDetail | PullRequestSummary,
): NonNullable<VcsStatusResult["pr"]> {
  return {
    number: detail.number,
    title: detail.title,
    url: detail.url,
    baseRef: detail.baseBranch,
    headRef: detail.headBranch,
    state: detail.state,
    ...(detail.isDraft === true ? { isDraft: true } : {}),
    updatedAt: detail.updatedAt,
  };
}

/**
 * Reopening a PR within a minute reuses detail and activity. Explicit refreshes and
 * turn notifications still revalidate. Mutations run serially per environment: actions on the same
 * pull request are order-sensitive. Labels update optimistically; confirmed edits update cached state.
 */
export function createPullRequestEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | PullRequestDiffLoader | R, E>,
) {
  const refreshes = createPullRequestRefreshAtomFamily(runtime);
  const commandScheduler = createAtomCommandScheduler();
  const routedRequest = createPullRequestRouter();
  const serialPerEnvironment = {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;
  const activity = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:activity",
      tag: WS_METHODS.pullRequestsActivity,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsActivity, input),
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
  );
  const detail = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:detail",
      tag: WS_METHODS.pullRequestsDetail,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsDetail, input),
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
  );
  const preview = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:preview",
      tag: WS_METHODS.pullRequestsPreview,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsPreview, input),
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
  );
  // Only the catalogue is shared: applied state belongs to each pull request. Keep project
  // and environment in the key because repository access can differ between connections.
  const repositoryLabels = Atom.family((_key: string) =>
    Atom.make<{
      readonly candidates: ReadonlyArray<
        Omit<PullRequestLabelCandidateList["candidates"][number], "isApplied">
      >;
      readonly truncated: boolean;
    } | null>(null).pipe(Atom.setIdleTTL(30 * 60_000)),
  );
  const repositoryLabelCandidates = ({
    environmentId,
    input,
  }: {
    readonly environmentId: EnvironmentId;
    readonly input: PullRequestRef;
  }) =>
    repositoryLabels(
      JSON.stringify([environmentId, input.projectId, input.host ?? null, input.repository]),
    );
  const labelCandidates = writableQueryFamily(
    createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:label-candidates",
      staleTimeMs: 60_000,
      idleTtlMs: 30 * 60_000,
      execute: Effect.fn("pullRequests.labelCandidates")(function* (input: PullRequestRef) {
        const result = yield* routedRequest(WS_METHODS.pullRequestsLabelCandidates, input);
        const supervisor = yield* EnvironmentSupervisor;
        const registry = yield* AtomRegistry.AtomRegistry;
        registry.set(
          repositoryLabelCandidates({ environmentId: supervisor.target.environmentId, input }),
          {
            candidates: result.candidates.map(({ name, color, description }) => ({
              name,
              color,
              description,
            })),
            truncated: result.truncated,
          },
        );
        return result;
      }),
    }),
    30 * 60_000,
  );
  const reviewerCandidates = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:reviewer-candidates",
      tag: WS_METHODS.pullRequestsReviewerCandidates,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsReviewerCandidates, input),
      staleTimeMs: 60_000,
    }),
  );
  // Overlay the latest read rather than saving a snapshot: rollback must not undo other changes.
  const pendingLabelEdits = Atom.family((_source: ReturnType<typeof detail>) =>
    Atom.make<ReadonlyArray<PendingLabelEdit>>([]).pipe(Atom.setIdleTTL(5 * 60_000)),
  );
  function withPendingLabelEdits<A, E>(
    family: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: PullRequestRef;
    }) => Atom.Writable<AsyncResult.AsyncResult<A, E>>,
    update: (value: A, edit: PendingLabelEdit) => A,
    idleTtlMs = 5 * 60_000,
  ) {
    const overlays = Atom.family((source: ReturnType<typeof family>) =>
      Atom.family((pending: ReturnType<typeof pendingLabelEdits>) =>
        Atom.writable(
          (get) => {
            const result = get(source);
            const edits = get(pending);
            return edits.length === 0
              ? result
              : AsyncResult.map(result, (value) => edits.reduce(update, value));
          },
          (context, value: AsyncResult.AsyncResult<A, E>) => context.set(source, value),
          (refresh) => refresh(source),
        ).pipe(Atom.setIdleTTL(idleTtlMs)),
      ),
    );
    return (target: Parameters<typeof family>[0]) =>
      overlays(family(target))(pendingLabelEdits(detail(target)));
  }
  const optimisticDetail = withPendingLabelEdits(detail, (value, edit) => ({
    ...value,
    labels: applyLabelEdit(value.labels, edit),
  }));
  const optimisticLabelCandidates = withPendingLabelEdits(
    labelCandidates,
    (value, edit) => {
      const names = new Set(edit.labels.map((label) => label.name));
      return {
        ...value,
        candidates: value.candidates.map((candidate) =>
          names.has(candidate.name) ? { ...candidate, isApplied: edit.applied } : candidate,
        ),
      };
    },
    30 * 60_000,
  );
  const setLabelsRpc = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:pull-requests:set-labels",
    tag: WS_METHODS.pullRequestsSetLabels,
    execute: (input) => routedRequest(WS_METHODS.pullRequestsSetLabels, input),
    scheduler: commandScheduler,
    concurrency: serialPerEnvironment,
  });
  const setLabels: typeof setLabelsRpc = {
    ...setLabelsRpc,
    run: async (registry, target) => {
      const candidatesAtom = labelCandidates(target);
      const candidates = Option.getOrNull(AsyncResult.value(registry.get(candidatesAtom)));
      const catalogue =
        candidates?.candidates ?? registry.get(repositoryLabelCandidates(target))?.candidates;
      const { labels, applied } = target.input;
      const edit = {
        labels: labels.map((name) => ({
          name,
          color: catalogue?.find((candidate) => candidate.name === name)?.color ?? null,
        })),
        applied,
      };
      const pending = pendingLabelEdits(detail(target));
      // Submission must update the UI even when an earlier mutation owns the RPC lane.
      registry.update(pending, (edits) => [...edits, edit]);
      try {
        const result = await setLabelsRpc.run(registry, target);
        if (AsyncResult.isSuccess(result)) {
          const names = new Set(labels);
          updateCached(registry, candidatesAtom, (value) => ({
            ...value,
            candidates: value.candidates.map((candidate) =>
              names.has(candidate.name) ? { ...candidate, isApplied: applied } : candidate,
            ),
          }));
          updateCached(registry, detail(target), (value) => ({
            ...value,
            labels: applyLabelEdit(value.labels, edit),
          }));
        }
        return result;
      } finally {
        registry.update(pending, (edits) => edits.filter((pendingEdit) => pendingEdit !== edit));
      }
    },
  };
  return {
    refreshes,
    linkedThreads: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:linked-threads",
      tag: WS_METHODS.pullRequestsLinkedThreads,
      staleTimeMs: 0,
      refreshIntervalMs: 10_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:list",
      tag: WS_METHODS.pullRequestsList,
      staleTimeMs: 30_000,
      refreshTrigger: ({ environmentId, input }) =>
        input.cursors === undefined ? refreshes({ environmentId, input: {} }) : undefined,
    }),
    /**
     * The line counts for rows the listing has already handed over. Its own query because the
     * listing is quicker without them — measured over twelve repositories, ~4.0s against ~7.1s —
     * so the rows arrive first and their stats a moment later. Kept longer than the listing:
     * a change request's size only moves when somebody pushes to it.
     */
    listStats: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:list-stats",
      tag: WS_METHODS.pullRequestsListStats,
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
    detail: optimisticDetail,
    preview,
    activity,
    threadComments: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:thread-comments",
      tag: WS_METHODS.pullRequestsThreadComments,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsThreadComments, input),
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.cursor]),
      },
    }),
    diff: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:diff",
      staleTimeMs: 60_000,
      execute: (input: PullRequestDiffInput) =>
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor;
          const loader = yield* PullRequestDiffLoader;
          const prepared = yield* SubscriptionRef.get(supervisor.prepared);
          if (Option.isNone(prepared)) {
            return yield* new EnvironmentHttpConnectionNotReadyError({
              message: "The environment HTTP connection is not ready.",
            });
          }
          return yield* loader.load(prepared.value, input);
        }),
    }),
    diffFileContents: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:diff-file-contents",
      tag: WS_METHODS.pullRequestsDiffFileContents,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsDiffFileContents, input),
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.projectId,
            input.host?.toLowerCase() ?? null,
            input.repository,
            input.number,
            input.commit ?? null,
            input.changeType,
            input.oldPath,
            input.newPath,
          ]),
      },
    }),
    filesViewed: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:files-viewed",
      tag: WS_METHODS.pullRequestsFilesViewed,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsFilesViewed, input),
      staleTimeMs: 15_000,
    }),
    /**
     * One write in flight per change request: the host applies these in order, and a reader
     * ticking down a file list faster than the round trip would otherwise race their own presses.
     */
    setFilesViewed: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:set-files-viewed",
      tag: WS_METHODS.pullRequestsSetFilesViewed,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsSetFilesViewed, input),
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.repository, input.number]),
      },
    }),
    runAction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:run-action",
      tag: WS_METHODS.pullRequestsRunAction,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsRunAction, input),
      onSuccess: (target, registry) => Effect.sync(() => registry.refresh(preview(target))),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:update",
      tag: WS_METHODS.pullRequestsUpdate,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsUpdate, input),
      onSuccess: (target, registry) => Effect.sync(() => registry.refresh(preview(target))),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    comment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:comment",
      tag: WS_METHODS.pullRequestsComment,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsComment, input),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    updateComment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:update-comment",
      tag: WS_METHODS.pullRequestsUpdateComment,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsUpdateComment, input),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: ({ environmentId, input: { projectId, host, repository, number } }, registry) =>
        Effect.sync(() =>
          registry.refresh(
            activity({
              environmentId,
              input: { projectId, ...(host === undefined ? {} : { host }), repository, number },
            }),
          ),
        ),
    }),
    submitReview: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:submit-review",
      tag: WS_METHODS.pullRequestsSubmitReview,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsSubmitReview, input),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    replyToThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:reply-to-thread",
      tag: WS_METHODS.pullRequestsReplyToThread,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsReplyToThread, input),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    /**
     * Its own query rather than part of the detail: the people who may be asked are only wanted
     * once somebody opens the reviewer menu, so this atom is read then and not before. Kept fresh
     * for a minute, because who has access to a repository changes far more slowly than the
     * change request it is being read for.
     */
    reviewerCandidates,
    requestReviewers: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:request-reviewers",
      tag: WS_METHODS.pullRequestsRequestReviewers,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsRequestReviewers, input),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          const { reviewers, requested } = target.input;
          const candidatesAtom = reviewerCandidates(target);
          const candidates = Option.getOrNull(AsyncResult.value(registry.get(candidatesAtom)));
          const selected =
            candidates?.candidates.filter((candidate) =>
              reviewers.some(
                (reviewer) => reviewer.id === candidate.id && reviewer.kind === candidate.kind,
              ),
            ) ?? [];
          const missingIdentities = selected.length < reviewers.length;
          updateCached(registry, candidatesAtom, (value) => ({
            ...value,
            candidates: value.candidates.map((candidate) =>
              selected.includes(candidate) ? { ...candidate, isRequested: requested } : candidate,
            ),
          }));
          const selectedLogins = new Set(
            selected.map((candidate) => candidate.login.toLowerCase()),
          );
          const updateReviewers = (
            actors: ReadonlyArray<PullRequestActor>,
            keep = (_actor: PullRequestActor) => false,
          ) =>
            requested
              ? [
                  ...actors,
                  ...selected
                    .filter(
                      (candidate) =>
                        !actors.some(
                          (actor) => actor.login.toLowerCase() === candidate.login.toLowerCase(),
                        ),
                    )
                    .map(({ login, name, avatarUrl }) => ({ login, name, avatarUrl })),
                ]
              : actors.filter(
                  (actor) => !selectedLogins.has(actor.login.toLowerCase()) || keep(actor),
                );
          updateCached(
            registry,
            detail(target),
            (value) => ({
              ...value,
              reviewers: updateReviewers(value.reviewers),
            }),
            missingIdentities,
          );
          updateCached(
            registry,
            activity(target),
            (value) => ({
              ...value,
              reviewers:
                value.reviewers === undefined
                  ? undefined
                  : updateReviewers(value.reviewers, (actor) =>
                      value.comments.some(
                        (comment) =>
                          (comment.kind === "review" || comment.kind === "review-comment") &&
                          comment.author?.login.toLowerCase() === actor.login.toLowerCase(),
                      ),
                    ),
            }),
            missingIdentities,
          );
        }),
    }),
    /** A repository catalogue for immediate display while a PR-specific read revalidates. */
    repositoryLabelCandidates,
    /** Read on menu-open; fresh for a minute and retained for thirty idle minutes. */
    labelCandidates: optimisticLabelCandidates,
    setLabels,
    setThreadResolution: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:set-thread-resolution",
      tag: WS_METHODS.pullRequestsSetThreadResolution,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsSetThreadResolution, input),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    setReaction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:set-reaction",
      tag: WS_METHODS.pullRequestsSetReaction,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsSetReaction, input),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    /**
     * Explicit refresh: forget the server's cached answers, then re-run the reads. A separate
     * request rather than a flag on a read, so only a person's refresh spends host requests
     * while every silent re-read shares the cache.
     */
    invalidate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:invalidate",
      tag: WS_METHODS.pullRequestsInvalidate,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsInvalidate, input),
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          if (input.reference !== undefined) {
            registry.refresh(preview({ environmentId, input: input.reference }));
          }
        }),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
  };
}
