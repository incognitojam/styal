import {
  WS_METHODS,
  PullRequestActivity,
  PullRequestDetail as PullRequestDetailSchema,
  PullRequestPreview,
  PullRequestReviewGuideResult,
  PullRequestListResult,
  PullRequestChecks,
  PullRequestDiffResult,
  PullRequestChangeBreakdown,
  PullRequestFilesViewedResult,
  PullRequestLinkedThreadsResult,
  type EnvironmentId,
  type PullRequestActor,
  type PullRequestActionInput,
  type PullRequestListInput,
  type PullRequestListStatsInput,
  type PullRequestListStatsResult,
  type PullRequestDetail,
  type PullRequestLabel,
  type PullRequestLabelCandidate,
  type PullRequestLabelCandidateList,
  type PullRequestDiffInput,
  type PullRequestRef,
  type PullRequestMergeMethod,
  PullRequestOperationError,
  type PullRequestSummary,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Stream from "effect/Stream";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { persistPullRequestStats } from "./pullRequestStatsPersistence.ts";
import { persistQuery } from "./queryPersistence.ts";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentQueryAtomFamily,
  type QueryAnswerHandler,
} from "./runtime.ts";
import { createPullRequestRouter } from "./pullRequestRouting.ts";
import * as PullRequestDiffLoader from "./pullRequestDiffHttp.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { isRpcClientError } from "../rpc/client.ts";

export {
  type PullRequestDiffLoadError,
  PullRequestDiffCredentialRejectedError,
} from "./pullRequestDiffHttp.ts";
export * as PullRequestDiffLoader from "./pullRequestDiffHttp.ts";

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

export interface RepositoryLabelCatalogue {
  readonly candidates: ReadonlyArray<Omit<PullRequestLabelCandidate, "isApplied">>;
  readonly truncated: boolean;
}

/**
 * A picker's list: the pull request's own read, else the repository catalogue another pull
 * request fetched. A truncated catalogue may omit labels that this one still needs to remove.
 */
export function pullRequestLabelCandidateList(
  read: PullRequestLabelCandidateList | null,
  catalogue: RepositoryLabelCatalogue | null,
  labels: PullRequestDetail["labels"],
): PullRequestLabelCandidateList | null {
  if (read !== null) return read;
  if (catalogue === null) return null;
  const names = new Set(catalogue.candidates.map((label) => label.name));
  const applied = new Set(labels.map((label) => label.name));
  return {
    candidates: [
      ...labels
        .filter((label) => !names.has(label.name))
        .map((label) => ({ ...label, description: null, isApplied: true })),
      ...catalogue.candidates.map((label) => ({ ...label, isApplied: applied.has(label.name) })),
    ],
    truncated: catalogue.truncated,
  };
}

function normalizePullRequestQuery<A>(
  query: (target: { readonly environmentId: EnvironmentId; readonly input: PullRequestRef }) => A,
) {
  return ({
    environmentId,
    input: { projectId, host, repository, number, allowStale, expectedAccountId },
  }: Parameters<typeof query>[0]) =>
    query({
      environmentId,
      input: {
        projectId,
        ...(host === undefined ? {} : { host }),
        repository,
        number,
        ...(allowStale === undefined ? {} : { allowStale }),
        ...(expectedAccountId === undefined ? {} : { expectedAccountId }),
      },
    });
}

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
  return normalizePullRequestQuery((target) => writable(family(target)));
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

function makePullRequestRefreshAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:pull-requests:turn-refreshes",
    tag: WS_METHODS.pullRequestsSubscribeRefreshes,
  });
}

const refreshFamiliesByRuntime = new WeakMap<
  object,
  ReturnType<typeof makePullRequestRefreshAtomFamily>
>();

function createPullRequestRefreshAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
): ReturnType<typeof makePullRequestRefreshAtomFamily<R, E>> {
  const existing = refreshFamiliesByRuntime.get(runtime);
  if (existing) return existing as ReturnType<typeof makePullRequestRefreshAtomFamily<R, E>>;
  const refreshes = makePullRequestRefreshAtomFamily(runtime);
  refreshFamiliesByRuntime.set(runtime, refreshes);
  return refreshes;
}

export function createLinkedPullRequestSummaryAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  refreshes = createPullRequestRefreshAtomFamily(runtime),
  onAnswer?: QueryAnswerHandler<PullRequestRef, PullRequestSummary>,
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
    isFinal: (summary) => summary.state === "merged",
    ...(onAnswer === undefined ? {} : { onAnswer }),
  });
}

/** Lets a client record what each answer says where it lands, rather than watching the data. */
export interface PullRequestAnswerHandlers {
  readonly list?: QueryAnswerHandler<PullRequestListInput, PullRequestListResult>;
  readonly listStats?: QueryAnswerHandler<PullRequestListStatsInput, PullRequestListStatsResult>;
  readonly detail?: QueryAnswerHandler<PullRequestRef, PullRequestDetail>;
  readonly checks?: QueryAnswerHandler<PullRequestRef, PullRequestChecks | null>;
  readonly reviewGuide?: QueryAnswerHandler<PullRequestRef, PullRequestReviewGuideResult>;
}

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
    ...(detail.autoMergeEnabled === undefined ? {} : { autoMergeEnabled: detail.autoMergeEnabled }),
    ...(detail.inMergeQueue === undefined ? {} : { inMergeQueue: detail.inMergeQueue }),
    updatedAt: detail.updatedAt,
  };
}

/**
 * Reopening a PR within a minute reuses detail and activity. Explicit refreshes and
 * turn notifications still revalidate. Mutations run serially per environment: actions on the same
 * pull request are order-sensitive. Labels update optimistically; confirmed edits update cached state.
 */
export function createPullRequestEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | PullRequestDiffLoader.PullRequestDiffLoader | R,
    E
  >,
  onAnswer: PullRequestAnswerHandlers = {},
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
      persistence: persistQuery(PullRequestActivity),
      tag: WS_METHODS.pullRequestsActivity,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsActivity, input),
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
  );
  const detail = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:detail",
      persistence: persistQuery(PullRequestDetailSchema),
      tag: WS_METHODS.pullRequestsDetail,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsDetail, input),
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
      ...(onAnswer.detail === undefined ? {} : { onAnswer: onAnswer.detail }),
    }),
  );
  const preview = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:preview",
      persistence: persistQuery(PullRequestPreview),
      tag: WS_METHODS.pullRequestsPreview,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsPreview, input),
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
  );
  // Only the catalogue is shared: applied state belongs to each pull request. Keep project
  // and environment in the key because repository access can differ between connections.
  const repositoryLabels = Atom.family((_key: string) =>
    Atom.make<RepositoryLabelCatalogue | null>(null).pipe(Atom.setIdleTTL(30 * 60_000)),
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
  // Hover cards read their own atoms, so a pending or failed hover read never decides where a
  // click on the same link goes.
  const previewCard = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:preview-card",
      persistence: persistQuery(PullRequestPreview),
      tag: WS_METHODS.pullRequestsPreview,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsPreview, input),
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
  );
  const labelCandidates = writableQueryFamily(
    createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:label-candidates",
      staleTimeMs: 60_000,
      idleTtlMs: 30 * 60_000,
      execute: Effect.fn("pullRequests.labelCandidates")(function* (input: PullRequestRef) {
        const result = yield* routedRequest(WS_METHODS.pullRequestsLabelCandidates, input);
        const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
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
  const reviewGuide = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:review-guide",
      persistence: persistQuery(PullRequestReviewGuideResult),
      tag: WS_METHODS.pullRequestsReviewGuide,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsReviewGuide, input),
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
      ...(onAnswer.reviewGuide === undefined ? {} : { onAnswer: onAnswer.reviewGuide }),
    }),
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
  const loadDiff = Effect.fn("PullRequests.loadDiff")(function* (input: PullRequestDiffInput) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const loader = yield* PullRequestDiffLoader.PullRequestDiffLoader;
    const prepared = yield* SubscriptionRef.get(supervisor.prepared);
    if (Option.isNone(prepared)) {
      return yield* new EnvironmentHttpConnectionNotReadyError({
        message: "The environment HTTP connection is not ready.",
      });
    }
    return yield* loader.load(prepared.value, input);
  });

  const runAction = Effect.fn("PullRequests.runAction")(function* (
    input: PullRequestActionInput & {
      readonly resolveMergeMethod?: (detail: PullRequestDetail) => PullRequestMergeMethod;
    },
  ) {
    const { resolveMergeMethod, ...actionInput } = input;
    let preparedInput = actionInput;
    if (actionInput.action === "merge" && resolveMergeMethod !== undefined) {
      const { projectId, host, repository, number } = actionInput;
      const reference = { projectId, host, repository, number, allowStale: false };
      const detail = yield* routedRequest(WS_METHODS.pullRequestsDetail, reference);
      if (detail.state === "merged") return;
      if (
        detail.state !== "open" ||
        detail.isDraft ||
        !detail.capabilities.actions.includes("merge") ||
        !detail.viewerPermissions.actions.includes("merge")
      ) {
        return yield* new PullRequestOperationError({
          operation: "runAction",
          detail: "This pull request cannot be merged.",
        });
      }
      if (detail.capabilities.stackActions) {
        const stack = yield* routedRequest(WS_METHODS.pullRequestsStack, reference);
        if (stack !== null) {
          return yield* new PullRequestOperationError({
            operation: "runAction",
            detail: "Open this pull request to merge its stack.",
          });
        }
      }
      const mergeMethod = yield* Effect.try({
        try: () => resolveMergeMethod(detail),
        catch: (cause) =>
          new PullRequestOperationError({
            operation: "runAction",
            detail: cause instanceof Error ? cause.message : "Could not choose a merge method.",
          }),
      });
      preparedInput = {
        ...actionInput,
        mergeMethod,
      };
    }
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const session = yield* SubscriptionRef.get(supervisor.session);
    return yield* routedRequest(WS_METHODS.pullRequestsRunAction, preparedInput).pipe(
      Effect.catchCause((cause) => {
        if (input.action !== "merge" && input.action !== "enable-auto-merge") {
          return Effect.failCause(cause);
        }
        const reconcile = Effect.gen(function* () {
          const numbers =
            input.stackNumber === undefined
              ? [input.number]
              : [
                  ...new Set([
                    ...(input.expectedStackHeads ?? []).map((head) => head.number),
                    input.number,
                  ]),
                ];
          // Stack success requires every requested layer, not just the selected PR.
          if (input.stackNumber !== undefined && !input.expectedStackHeads?.length) return false;
          const states = yield* Effect.forEach(numbers, (number) =>
            routedRequest(WS_METHODS.pullRequestsDetail, {
              projectId: input.projectId,
              host: input.host,
              repository: input.repository,
              number,
              allowStale: false,
            }),
          );
          return (
            states.every((detail) => detail.state === "merged") ||
            (input.action === "enable-auto-merge" &&
              states.every((detail) => detail.autoMergeEnabled === true))
          );
        });
        const checked = reconcile.pipe(
          Effect.catchCause((readCause) => {
            const failure = Cause.squash(readCause);
            if (
              !Cause.hasInterruptsOnly(readCause) &&
              !isRpcClientError(failure) &&
              (!(failure instanceof Error) ||
                !("_tag" in failure) ||
                failure._tag !== "EnvironmentRpcUnavailableError")
            ) {
              return Effect.succeed(false);
            }
            return SubscriptionRef.changes(supervisor.session).pipe(
              Stream.filter(
                (next) =>
                  Option.isSome(next) && (Option.isNone(session) || next.value !== session.value),
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.andThen(reconcile),
            );
          }),
          Effect.timeoutOption("10 seconds"),
          Effect.catchCause(() => Effect.succeedNone),
        );
        return checked.pipe(
          Effect.flatMap((merged) =>
            Option.isSome(merged) && merged.value ? Effect.void : Effect.failCause(cause),
          ),
        );
      }),
    );
  });

  return {
    refreshes,
    linkedThreads: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:linked-threads",
      persistence: persistQuery(PullRequestLinkedThreadsResult),
      tag: WS_METHODS.pullRequestsLinkedThreads,
      staleTimeMs: 0,
      refreshIntervalMs: 10_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
    // For callers that open a thread from the answer: a persisted one reads as final before
    // the connection is known, and a kept one can predate the thread.
    linkedThreadsUncached: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:linked-threads-uncached",
      tag: WS_METHODS.pullRequestsLinkedThreads,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:list",
      persistence: persistQuery(PullRequestListResult),
      tag: WS_METHODS.pullRequestsList,
      staleTimeMs: 30_000,
      refreshTrigger: ({ environmentId, input }) =>
        input.cursors === undefined ? refreshes({ environmentId, input: {} }) : undefined,
      ...(onAnswer.list === undefined ? {} : { onAnswer: onAnswer.list }),
    }),
    /**
     * Its own query because the listing is quicker without them — measured over twelve
     * repositories, ~4.0s against ~7.1s — so the rows arrive first and their stats a moment
     * later.
     */
    listStats: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:list-stats",
      persistence: persistPullRequestStats(),
      tag: WS_METHODS.pullRequestsListStats,
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
      ...(onAnswer.listStats === undefined ? {} : { onAnswer: onAnswer.listStats }),
    }),
    filterOptions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:filter-options",
      tag: WS_METHODS.pullRequestsFilterOptions,
      staleTimeMs: 5 * 60_000,
    }),
    detail: optimisticDetail,
    preview,
    previewCard,
    checks: normalizePullRequestQuery(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:pull-requests:checks",
        persistence: persistQuery(Schema.NullOr(PullRequestChecks)),
        tag: WS_METHODS.pullRequestsChecks,
        execute: (input) => routedRequest(WS_METHODS.pullRequestsChecks, input),
        staleTimeMs: 45_000,
        refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
        ...(onAnswer.checks === undefined ? {} : { onAnswer: onAnswer.checks }),
      }),
    ),
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
      persistence: persistQuery(PullRequestDiffResult),
      staleTimeMs: 60_000,
      execute: loadDiff,
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
      persistence: persistQuery(PullRequestFilesViewedResult),
      tag: WS_METHODS.pullRequestsFilesViewed,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsFilesViewed, input),
      staleTimeMs: 15_000,
    }),
    changeBreakdown: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:change-breakdown",
      persistence: persistQuery(PullRequestChangeBreakdown),
      tag: WS_METHODS.pullRequestsChangeBreakdown,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsChangeBreakdown, input),
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
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
      tag: WS_METHODS.pullRequestsRunAction,
      label: "environment-data:pull-requests:run-action",
      // Preparation belongs to the write's lane. Refreshable queries would restart it after
      // every preceding action, and preparing outside the lane could reorder the clicks.
      execute: runAction,
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          registry.refresh(detail({ environmentId, input }));
          registry.refresh(preview({ environmentId, input }));
          registry.refresh(previewCard({ environmentId, input }));
        }),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    reviewWorkflowRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:review-workflow-run",
      tag: WS_METHODS.pullRequestsReviewWorkflowRun,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsReviewWorkflowRun, input),
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
          const candidates = AsyncResult.getOrElse(registry.get(candidatesAtom), () => null);
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
    reviewGuide,
    generateReviewGuide: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:generate-review-guide",
      tag: WS_METHODS.pullRequestsGenerateReviewGuide,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsGenerateReviewGuide, input),
      onSuccess: (target, registry, result) =>
        Effect.sync(() => {
          updateCached(registry, reviewGuide(target), () => result, true);
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
     * A separate request rather than a flag on a read, so only a person's refresh spends
     * host requests while every silent re-read shares the cache.
     */
    invalidate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:invalidate",
      tag: WS_METHODS.pullRequestsInvalidate,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsInvalidate, input),
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          if (input.reference !== undefined) {
            registry.refresh(preview({ environmentId, input: input.reference }));
            registry.refresh(previewCard({ environmentId, input: input.reference }));
          }
        }),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
  };
}
