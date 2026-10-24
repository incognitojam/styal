import {
  CommandId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  type SourceControlProviderKind,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import * as WorkflowRunWatchUsage from "../../../telemetry/WorkflowRunWatchUsage.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import { pullRequestSyncKey } from "../../../pullRequest/pullRequestSyncKey.ts";
import { sourceControlDefinitions } from "../../../sourceControl/sourceControlDefinitions.ts";
import {
  normalizeThreadPullRequestKey,
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
  visibleThreadPullRequests,
} from "../../../sourceControl/threadPullRequests.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  type ListThreadPullRequestsResult,
  PullRequestLinkFailedError,
  PullRequestUrlInvalidError,
  PullRequestTargetIncompleteError,
  PullRequestHostRequiredError,
  PullRequestUrlUnavailableError,
  PullRequestUnlinkFailedError,
  PullRequestListFailedError,
  PullRequestNotOpenError,
  type PullRequestTargetInput,
  PullRequestWatchFailedError,
  PullRequestWatchFromSubagentError,
  PullRequestThreadNotFoundError,
  PullRequestThreadRequiredError,
  PullRequestGuideFailedError,
  PullRequestProjectNotFoundError,
  PullRequestsToolkit,
  type ThreadPullRequestEntry,
  WorkflowRunReadFailedError,
  WorkflowRunTargetIncompleteError,
  type WorkflowRunTargetInput,
  WorkflowRunUrlInvalidError,
  WorkflowRunWatchFailedError,
} from "./tools.ts";

interface ResolvedTarget {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

function projectHostAndProvider(project: OrchestrationProjectShell | undefined): {
  readonly host: string | null;
  readonly kind: SourceControlProviderKind | null;
} {
  const identity = project?.repositoryIdentity;
  const kind = identity?.provider ?? null;
  if (!identity || kind === null) return { host: null, kind: null };
  return {
    host: sourceControlDefinitions.changeRequestHost(identity, kind),
    kind,
  };
}

const resolveTarget = Effect.fn("PullRequestsToolkit.resolveTarget")(function* (
  input: PullRequestTargetInput,
  project: OrchestrationProjectShell | undefined,
) {
  if (input.url !== undefined) {
    const parsed = sourceControlDefinitions.parseChangeRequestUrl(input.url)?.link;
    if (parsed === undefined) {
      return yield* new PullRequestUrlInvalidError({});
    }
    return { ...normalizeThreadPullRequestKey(parsed), url: input.url } satisfies ResolvedTarget;
  }
  if (input.repository === undefined || input.number === undefined) {
    return yield* new PullRequestTargetIncompleteError({});
  }
  const projectHost = projectHostAndProvider(project);
  const host = (input.host ?? projectHost.host)?.toLowerCase();
  if (host === undefined) {
    return yield* new PullRequestHostRequiredError({});
  }
  const repository = input.repository.toLowerCase();
  // Without a URL, a public forge host says what shape its change request URLs take;
  // any other host is taken to run the project's own forge.
  const kind = sourceControlDefinitions.findByPublicHost(host)?.kind ?? projectHost.kind;
  const url =
    kind === null
      ? null
      : sourceControlDefinitions.get(kind).changeRequestUrl({
          host,
          repository,
          number: input.number,
          remoteUrl: project?.repositoryIdentity?.locator.remoteUrl,
        });
  if (url === null) {
    return yield* new PullRequestUrlUnavailableError({});
  }
  return {
    ...normalizeThreadPullRequestKey({ host, repository, number: input.number, url }),
    url,
  } satisfies ResolvedTarget;
});

/** Host, repository and run ID from a workflow run URL, or a job URL below one. */
export function parseWorkflowRunUrl(
  url: string,
): { readonly host: string; readonly repository: string; readonly runId: number } | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  const match = /^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/|$)/.exec(parsed.pathname);
  if (match === null) return null;
  const runId = Number(match[2]);
  if (!Number.isSafeInteger(runId) || runId <= 0) return null;
  return { host: parsed.host.toLowerCase(), repository: match[1]!.toLowerCase(), runId };
}

const resolveWorkflowRunTarget = Effect.fn("PullRequestsToolkit.resolveWorkflowRunTarget")(
  function* (input: WorkflowRunTargetInput, project: OrchestrationProjectShell | undefined) {
    if (input.url !== undefined) {
      const parsed = parseWorkflowRunUrl(input.url);
      if (parsed === null) return yield* new WorkflowRunUrlInvalidError({});
      return parsed;
    }
    if (input.repository === undefined || input.runId === undefined) {
      return yield* new WorkflowRunTargetIncompleteError({});
    }
    const host = (input.host ?? projectHostAndProvider(project).host)?.toLowerCase();
    if (host === undefined) return yield* new PullRequestHostRequiredError({});
    return { host, repository: input.repository.toLowerCase(), runId: input.runId };
  },
);

function entryOf(
  link: ThreadPullRequestLink,
  chains: ReturnType<typeof resolveThreadPullRequestChains>,
): ThreadPullRequestEntry {
  const key = threadPullRequestKeyOf(link);
  let stack: ThreadPullRequestEntry["stack"] = null;
  for (const chain of chains) {
    if (chain.layers.length < 2) continue;
    const index = chain.layers.findIndex((layer) => threadPullRequestKeyOf(layer) === key);
    if (index !== -1) {
      stack = { kind: chain.kind, position: chain.depths[index]! + 1, size: chain.layers.length };
      break;
    }
  }
  return {
    host: normalizeThreadPullRequestKey(link).host,
    repository: link.repository,
    number: link.number,
    url: link.url,
    source: link.source,
    watching: link.watch !== undefined,
    state: link.snapshot?.state ?? null,
    title: link.snapshot?.title ?? null,
    headBranch: link.snapshot?.headBranch ?? null,
    baseBranch: link.snapshot?.baseBranch ?? null,
    isDraft: link.snapshot?.isDraft ?? null,
    stack,
  };
}

export function listThreadPullRequests(
  thread: Pick<OrchestrationV2ThreadShell, "pullRequests">,
): ListThreadPullRequestsResult {
  const chains = resolveThreadPullRequestChains(thread.pullRequests ?? []);
  return {
    pullRequests: visibleThreadPullRequests(thread.pullRequests ?? []).map((link) =>
      entryOf(link, chains),
    ),
    chains: chains.map((chain) => ({
      kind: chain.kind,
      numbers: chain.layers.map((layer) => layer.number),
    })),
  };
}

function projectForPullRequest(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  target: { readonly host: string; readonly repository: string },
  preferred: OrchestrationProjectShell | undefined,
): OrchestrationProjectShell | undefined {
  // The same rule the guide service uses: a pull request reads through a project whose checkout
  // names it with the same host-level key, which also maps Azure DevOps' org/project/_git/repo.
  const matches = (project: OrchestrationProjectShell) => {
    const own = pullRequestSyncKey(
      { projectId: project.id, host: target.host, repository: target.repository, number: 1 },
      project.repositoryIdentity ?? undefined,
    );
    const projectKey =
      project.repositoryIdentity == null
        ? null
        : pullRequestSyncKey(
            {
              projectId: project.id,
              repository:
                sourceControlDefinitions.repositorySelector(project.repositoryIdentity) ?? "",
              number: 1,
            },
            project.repositoryIdentity,
          );
    return (
      own !== null &&
      projectKey !== null &&
      own.host === projectKey.host &&
      own.repository === projectKey.repository
    );
  };
  if (preferred !== undefined && matches(preferred)) return preferred;
  return projects.find(matches);
}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const reviewGuides = yield* PullRequestReviewGuideService.PullRequestReviewGuideService;

  const projects = yield* ProjectService.ProjectService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;

  const commandId = (tag: string, threadId: ThreadId) =>
    crypto.randomUUIDv4().pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:${tag}:${threadId}:${uuid}`)),
    );

  const requireThread = Effect.fn("PullRequestsToolkit.requireThread")(function* (
    Failure:
      | typeof PullRequestLinkFailedError
      | typeof PullRequestUnlinkFailedError
      | typeof PullRequestListFailedError
      | typeof PullRequestWatchFailedError
      | typeof WorkflowRunWatchFailedError,
    requested: ThreadId | undefined,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
    const threadId = requested ?? scope.thread?.threadId;
    if (threadId === undefined) {
      return yield* new PullRequestThreadRequiredError();
    }
    const thread = yield* engine
      .getThreadShell(threadId)
      .pipe(Effect.map(Option.fromNullishOr))
      .pipe(Effect.mapError((cause) => new Failure({ cause })));
    if (Option.isNone(thread) || thread.value.deletedAt !== null) {
      return yield* new PullRequestThreadNotFoundError({ threadId });
    }
    return thread.value;
  });

  const projectOf = (
    thread: OrchestrationV2ThreadShell,
    Failure:
      | typeof PullRequestLinkFailedError
      | typeof PullRequestUnlinkFailedError
      | typeof PullRequestWatchFailedError
      | typeof WorkflowRunWatchFailedError,
  ) =>
    projects.getShell(thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError((cause) => new Failure({ cause })),
    );

  const dispatchFailure =
    (
      Failure:
        | typeof PullRequestLinkFailedError
        | typeof PullRequestUnlinkFailedError
        | typeof PullRequestWatchFailedError
        | typeof WorkflowRunWatchFailedError,
    ) =>
    <E>(
      cause: Cause.Cause<E>,
    ): Effect.Effect<
      never,
      | PullRequestLinkFailedError
      | PullRequestUnlinkFailedError
      | PullRequestWatchFailedError
      | WorkflowRunWatchFailedError
    > =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.fail(new Failure({ cause }));

  const setWatching = Effect.fn("PullRequestsToolkit.setWatching")(function* (
    input: PullRequestTargetInput,
    watching: boolean,
  ) {
    const thread = yield* requireThread(PullRequestWatchFailedError, input.threadId);
    const project = yield* projectOf(thread, PullRequestWatchFailedError);
    const target = yield* resolveTarget(input, project);
    const watchedLink = (shell: OrchestrationV2ThreadShell) =>
      threadPullRequestsOf(shell).find(
        (link) => link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, target),
      );
    if (watching && thread.lineage.relationshipToParent === "subagent") {
      return yield* new PullRequestWatchFromSubagentError();
    }
    const before = watchedLink(thread);
    if (watching && before?.snapshot?.state === "merged") {
      return yield* new PullRequestNotOpenError({ state: "merged" });
    }
    yield* engine
      .dispatch({
        type: "thread.pull-request.watch",
        commandId: yield* commandId("mcp-pr-watch", thread.id),
        threadId: thread.id,
        host: target.host,
        repository: target.repository,
        number: target.number,
        watching,
        ...(watching ? { link: { url: target.url, source: "agent" as const } } : {}),
      })
      .pipe(Effect.catchCause(dispatchFailure(PullRequestWatchFailedError)));
    const after = yield* requireThread(PullRequestWatchFailedError, thread.id);
    return {
      host: target.host,
      repository: target.repository,
      number: target.number,
      url: target.url,
      watching: watchedLink(after)?.watch !== undefined,
      wasWatching: before?.watch !== undefined,
    };
  });

  /**
   * Starts or stops a workflow run watch. A run is read before it is watched, so a wrong ID
   * fails here and a run that already completed is reported instead of watched.
   */
  const setWorkflowRunWatching = Effect.fn("PullRequestsToolkit.setWorkflowRunWatching")(function* (
    input: WorkflowRunTargetInput,
    watching: boolean,
  ) {
    const thread = yield* requireThread(WorkflowRunWatchFailedError, input.threadId);
    const project = yield* projectOf(thread, WorkflowRunWatchFailedError);
    const target = yield* resolveWorkflowRunTarget(input, project);
    const watchOf = (shell: OrchestrationV2ThreadShell) =>
      (shell.workflowRuns ?? []).find(
        (run) =>
          run.runId === target.runId &&
          run.host.toLowerCase() === target.host &&
          run.repository.toLowerCase() === target.repository,
      );
    if (watching && thread.lineage.relationshipToParent === "subagent") {
      return yield* new PullRequestWatchFromSubagentError();
    }
    const before = watchOf(thread);
    const result = {
      ...target,
      url:
        before?.url ?? `https://${target.host}/${target.repository}/actions/runs/${target.runId}`,
      name: before?.name ?? null,
      wasWatching: before !== undefined,
      conclusion: null,
      failedJobs: [],
    };
    if (watching && before !== undefined) return { ...result, watching: true };
    if (!watching && before === undefined) return { ...result, watching: false };
    const run = watching
      ? yield* pullRequests
          .workflowRun({
            projectId: thread.projectId,
            host: target.host,
            repository: target.repository,
            runId: target.runId,
          })
          .pipe(
            Effect.mapError(
              (cause) => new WorkflowRunReadFailedError({ detail: cause.message, cause }),
            ),
          )
      : null;
    if (run?.completed) {
      return {
        ...result,
        url: run.url,
        name: run.name,
        watching: false,
        conclusion: run.conclusion ?? "unknown",
        failedJobs: run.failedJobs,
      };
    }
    yield* engine
      .dispatch({
        type: "thread.workflow-run.watch",
        commandId: yield* commandId("mcp-workflow-run-watch", thread.id),
        threadId: thread.id,
        ...target,
        watching,
        ...(run === null ? {} : { run: { url: run.url, name: run.name } }),
      })
      .pipe(Effect.catchCause(dispatchFailure(WorkflowRunWatchFailedError)));
    const after = yield* requireThread(WorkflowRunWatchFailedError, thread.id);
    return {
      ...result,
      url: run?.url ?? result.url,
      name: run?.name ?? result.name,
      watching: watchOf(after) !== undefined,
    };
  });

  const locateAll = Effect.fn("PullRequestsToolkit.locateAll")(function* (
    targets: ReadonlyArray<Omit<PullRequestTargetInput, "threadId">>,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
    const callerThread =
      scope.thread === undefined
        ? undefined
        : yield* engine.getThreadShell(scope.thread.threadId).pipe(
            Effect.orElseSucceed(() => null),
            Effect.map((shell) => shell ?? undefined),
          );
    const known = yield* projects
      .listShells()
      .pipe(Effect.mapError((cause) => new PullRequestListFailedError({ cause })));
    const callerProject = known.find((project) => project.id === callerThread?.projectId);
    // A pull request named by host and repository builds its URL through the project that holds
    // it, which need not be the caller's.
    const urlProject = (input: PullRequestTargetInput) =>
      input.url === undefined && input.host !== undefined && input.repository !== undefined
        ? (projectForPullRequest(
            known,
            { host: input.host, repository: input.repository },
            callerProject,
          ) ?? callerProject)
        : callerProject;
    return yield* Effect.forEach(targets, (input) =>
      resolveTarget(input, urlProject(input)).pipe(
        Effect.map((target) => ({
          input,
          target,
          project: projectForPullRequest(known, target, callerProject),
          failure: null,
        })),
        Effect.catch((error) =>
          Effect.succeed({ input, target: null, project: undefined, failure: error.message }),
        ),
      ),
    );
  });

  const guideReference = (
    project: OrchestrationProjectShell,
    target: { readonly host: string; readonly repository: string; readonly number: number },
  ) => ({
    projectId: project.id,
    host: target.host,
    repository: target.repository,
    number: target.number,
  });

  const guideFailureDetail = (error: { readonly message: string }) =>
    "detail" in error && typeof error.detail === "string" ? error.detail : error.message;

  const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
    handle: (params: P) => Effect.Effect<A, E, R>,
  ) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

  return {
    link_pull_request: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(PullRequestLinkFailedError, input.threadId);
        const project = yield* projectOf(thread, PullRequestLinkFailedError);
        const target = yield* resolveTarget(input, project);
        const existing = threadPullRequestsOf(thread).find((link) =>
          threadPullRequestKeysEqual(link, target),
        );
        if (existing && existing.source !== "stack-dismissed")
          return { ...target, alreadyLinked: true };
        const alreadyLinked = yield* engine
          .dispatch({
            type: "thread.pull-request.link",
            commandId: yield* commandId("mcp-pr-link", thread.id),
            threadId: thread.id,
            host: target.host,
            repository: target.repository,
            number: target.number,
            url: target.url,
            source: "agent",
          })
          .pipe(
            Effect.as(false),

            Effect.catchCause(dispatchFailure(PullRequestLinkFailedError)),
          );
        return { ...target, alreadyLinked };
      }),
    ),
    unlink_pull_request: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(PullRequestUnlinkFailedError, input.threadId);
        const project = yield* projectOf(thread, PullRequestUnlinkFailedError);
        const target = yield* resolveTarget(input, project);
        if (!threadPullRequestsOf(thread).some((link) => threadPullRequestKeysEqual(link, target)))
          return {
            host: target.host,
            repository: target.repository,
            number: target.number,
            wasLinked: false,
          };
        const wasLinked = yield* engine
          .dispatch({
            type: "thread.pull-request.unlink",
            commandId: yield* commandId("mcp-pr-unlink", thread.id),
            threadId: thread.id,
            host: target.host,
            repository: target.repository,
            number: target.number,
          })
          .pipe(
            Effect.as(true),

            Effect.catchCause(dispatchFailure(PullRequestUnlinkFailedError)),
          );
        return {
          host: target.host,
          repository: target.repository,
          number: target.number,
          wasLinked,
        };
      }),
    ),
    list_thread_pull_requests: McpToolAccess.reads((input) =>
      requireThread(PullRequestListFailedError, input.threadId).pipe(
        Effect.map(listThreadPullRequests),
      ),
    ),
    watch_pull_request: writesThread((input) => setWatching(input, true)),
    unwatch_pull_request: writesThread((input) => setWatching(input, false)),
    watch_workflow_run: writesThread((input) => setWorkflowRunWatching(input, true)),
    unwatch_workflow_run: writesThread((input) => setWorkflowRunWatching(input, false)),
    write_pull_request_guides: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const located = yield* locateAll(input.pullRequests);
        const guides = yield* Effect.forEach(
          located,
          (entry) =>
            Effect.gen(function* () {
              if (entry.target === null) {
                return {
                  host: entry.input.host ?? "",
                  repository: entry.input.repository ?? "",
                  number: entry.input.number ?? 0,
                  url: entry.input.url ?? "",
                  outcome: "failed" as const,
                  detail: entry.failure,
                };
              }
              const identity = {
                host: entry.target.host,
                repository: entry.target.repository,
                number: entry.target.number,
                url: entry.target.url,
              };
              if (entry.project === undefined) {
                return {
                  ...identity,
                  outcome: "failed" as const,
                  detail: new PullRequestProjectNotFoundError({
                    repository: entry.target.repository,
                  }).message,
                };
              }
              return yield* reviewGuides.generate(guideReference(entry.project, entry.target)).pipe(
                Effect.map((result) => ({
                  ...identity,
                  outcome: result.started ? ("started" as const) : ("running" as const),
                  detail: null,
                })),
                Effect.catch((error) =>
                  Effect.succeed({
                    ...identity,
                    outcome: "failed" as const,
                    detail: guideFailureDetail(error),
                  }),
                ),
              );
            }),
          { concurrency: 4 },
        );
        return { guides };
      }),
    ),
    read_pull_request_guide: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const [entry] = yield* locateAll([input]);
        if (entry !== undefined && entry.target === null) {
          return yield* new PullRequestGuideFailedError({ detail: entry.failure ?? "" });
        }
        if (entry === undefined || entry.target === null || entry.project === undefined) {
          return yield* new PullRequestProjectNotFoundError({
            repository: entry?.target.repository ?? input.repository ?? "",
          });
        }
        const result = yield* reviewGuides.get(guideReference(entry.project, entry.target)).pipe(
          Effect.mapError(
            (error) =>
              new PullRequestGuideFailedError({
                detail: guideFailureDetail(error),
                cause: error,
              }),
          ),
        );
        return {
          host: entry.target.host,
          repository: entry.target.repository,
          number: entry.target.number,
          url: entry.target.url,
          guide: result.guide,
          run: result.run,
          currentHeadSha: result.currentHeadSha,
          stale:
            result.guide !== null &&
            result.currentHeadSha !== null &&
            result.guide.headSha !== result.currentHeadSha,
        };
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof PullRequestsToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(
  PullRequestsToolkit,
  make.pipe(
    Effect.flatMap((handlers) =>
      McpToolAccess.wrapHandlers(handlers, WorkflowRunWatchUsage.observeHandlers),
    ),
  ),
);
