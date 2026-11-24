import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  PullRequestOperationError,
  PullRequestUnavailableError,
  ThreadId,
  type OrchestrationV2ServerCommand as OrchestrationCommand,
  type OrchestrationProjectShell,
  type PullRequestRef,
  type PullRequestCheck,
  type PullRequestDetail,
  type PullRequestReviewGuideResult,
  type ThreadPullRequestLink,
  type ThreadWorkflowRunWatch,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ProjectEnrichment from "../../../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../../../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import type { Tool } from "effect/ai";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import { evaluatePullRequestWatch } from "../../../orchestration-v2/pullRequestWatch.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  type PullRequestTestThread,
  v2PullRequestThread,
} from "../../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import type { ProviderWorkflowRun } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import * as AnalyticsService from "../../../telemetry/AnalyticsService.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import { listThreadPullRequests } from "./handlers.ts";
import * as PullRequestsHandlers from "./handlers.ts";
import { parseWorkflowRunUrl } from "./handlers.ts";
import {
  CHECKS_ALREADY_PASSED_WATCH_NEXT,
  CHILD_PULL_REQUEST_REPORT_NEXT,
  PullRequestsToolkit,
} from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

const testCrypto = SecureRandom.make((size) => new Uint8Array(size).fill(7));

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: THREAD_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

function makeProject(
  repositoryIdentity: OrchestrationProjectShell["repositoryIdentity"] = {
    canonicalKey: "github.com/t3tools/t3code",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:T3Tools/T3Code.git",
    },
    provider: SourceControlProviderKind.make("github"),
    displayName: "T3Tools/T3Code",
    owner: "T3Tools",
    name: "T3Code",
  },
): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    repositoryIdentity,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeThread(pullRequests: ReadonlyArray<ThreadPullRequestLink>): PullRequestTestThread {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
  };
}

function makeLink(
  number: number,
  overrides: Partial<ThreadPullRequestLink> & {
    readonly headBranch?: string;
    readonly baseBranch?: string;
  } = {},
): ThreadPullRequestLink {
  const { headBranch, baseBranch, ...rest } = overrides;
  return {
    host: "github.com",
    repository: "t3tools/t3code",
    number,
    url: `https://github.com/t3tools/t3code/pull/${number}`,
    source: "manual",
    linkedAt: "2026-08-10T00:00:00.000Z",
    snapshot:
      headBranch === undefined
        ? null
        : {
            state: "open",
            title: `PR ${number}`,
            headBranch,
            baseBranch: baseBranch ?? "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: "2026-08-27T00:00:00.000Z",
          },
    stack: null,
    ...rest,
  };
}

const pullRequestDetail = (
  checks: ReadonlyArray<PullRequestCheck>,
  mergeability: "mergeable" | "conflicting" = "mergeable",
): PullRequestDetail => ({
  provider: SourceControlProviderKind.make("github"),
  capabilities: {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: false,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
  projectId: PROJECT_ID,
  projectTitle: "Project",
  workspaceRoot: "/workspace/project",
  repository: "t3tools/t3code",
  number: 9,
  title: "Pull request",
  body: "",
  url: "https://github.com/t3tools/t3code/pull/9",
  author: null,
  state: "open",
  isDraft: false,
  mergeability,
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks,
  mergeCapabilities: { merge: true, squash: true, rebase: true },
});

interface HarnessOptions {
  readonly detailFailure?: PullRequestService.PullRequestError;
  readonly checks?: ReadonlyArray<PullRequestCheck>;
  readonly mergeability?: "mergeable" | "conflicting";
  readonly enrichment?: ProjectEnrichment.ProjectEnrichmentService["Service"];
  readonly thread?: PullRequestTestThread | null;
  readonly project?: OrchestrationProjectShell | null;
  readonly reject?: (command: OrchestrationCommand) => string | null;
  /** What the host reports for a workflow run; every run is unreadable when omitted. */
  readonly workflowRun?: ProviderWorkflowRun;
  readonly workflowRuns?: ReadonlyArray<ThreadWorkflowRunWatch>;
  /** The calling thread's run has ended, so the access check refuses changes. */
  readonly callerIdle?: boolean;
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  readonly generate?: (
    input: PullRequestRef,
  ) => Effect.Effect<
    PullRequestReviewGuideResult & { started: boolean },
    PullRequestOperationError
  >;
}

const NO_GUIDE: PullRequestReviewGuideResult = { guide: null, run: null, currentHeadSha: "head-1" };

const makeHarness = Effect.fn("makePullRequestsToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const workflowRuns = yield* Ref.make(options.workflowRuns ?? []);
  const workflowRunReads = yield* Ref.make<ReadonlyArray<number>>([]);
  const usage: Array<Readonly<Record<string, unknown>>> = [];
  const guideRequests = yield* Ref.make<ReadonlyArray<PullRequestRef>>([]);
  const thread = options.thread === undefined ? makeThread([]) : options.thread;
  const project = options.project === undefined ? makeProject() : options.project;
  const dispatch: Orchestrator.OrchestratorV2Shape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const rejection = options.reject?.(command) ?? null;
      if (rejection !== null)
        return yield* new Orchestrator.OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: rejection,
        });
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      if (command.type === "thread.workflow-run.watch") {
        yield* Ref.update(workflowRuns, (runs) => [
          ...runs.filter((run) => run.runId !== command.runId),
          ...(command.watching && command.run
            ? [{ ...command, ...command.run, startedAt: "2026-08-20T00:00:00.000Z" }]
            : []),
        ]);
      }
      return { sequence: 1, storedEvents: [] };
    });
  const layerDependencies = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      getShell: () =>
        project && options.enrichment
          ? options.enrichment
              .getAvailable(project.workspaceRoot)
              .pipe(
                Effect.map(({ repositoryIdentity }) =>
                  Option.some({ ...project, repositoryIdentity }),
                ),
              )
          : Effect.succeed(Option.fromNullishOr(project)),
      listShells: () =>
        Effect.forEach(options.projects ?? (project ? [project] : []), (shell) =>
          options.enrichment
            ? options.enrichment
                .getAvailable(shell.workspaceRoot)
                .pipe(Effect.map(({ repositoryIdentity }) => ({ ...shell, repositoryIdentity })))
            : Effect.succeed(shell),
        ),
    }),
    options.enrichment
      ? Layer.succeed(ProjectEnrichment.ProjectEnrichmentService, options.enrichment)
      : Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({
          readRepositoryIdentity: () => Effect.succeed(null),
        }),
    Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({
      get: () => Effect.succeed(NO_GUIDE),
      generate: (input) =>
        Ref.update(guideRequests, (recorded) => [...recorded, input]).pipe(
          Effect.andThen(
            options.generate?.(input) ??
              Effect.succeed({
                ...NO_GUIDE,
                run: {
                  _tag: "Running" as const,
                  headSha: "head-1",
                  startedAt: "2026-10-11T00:00:00.000Z",
                },
                started: true,
              }),
          ),
        ),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (id) =>
        Ref.get(workflowRuns).pipe(
          Effect.map((runs) =>
            thread && id === thread.id
              ? { ...v2PullRequestThread(thread), workflowRuns: runs.map(watchFields) }
              : null,
          ),
        ),
      dispatch,
    }),
    Layer.mock(PullRequestService.PullRequestService)({
      detail: () =>
        options.detailFailure
          ? Effect.fail(options.detailFailure)
          : Effect.succeed(pullRequestDetail(options.checks ?? [], options.mergeability)),
      workflowRun: (input) =>
        Ref.update(workflowRunReads, (reads) => [...reads, input.runId]).pipe(
          Effect.andThen(
            options.workflowRun === undefined
              ? Effect.fail(
                  new PullRequestOperationError({
                    operation: "workflowRun",
                    detail: "Not Found",
                  }),
                )
              : Effect.succeed(options.workflowRun),
          ),
        ),
    }),
    Layer.succeed(SecureRandom.SecureRandom, testCrypto),
    options.callerIdle
      ? Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed(McpToolAccessTestkit.liveThreadShell(id, { activeRunId: null })),
        })
      : McpToolAccessTestkit.liveThreadsLayer,
    Layer.succeed(
      AnalyticsService.AnalyticsService,
      AnalyticsService.AnalyticsService.of({
        recordOwners: () => Effect.void,
        record: (_event, properties) =>
          Effect.sync(() => {
            usage.push(properties ?? {});
          }),
        flush: Effect.void,
      }),
    ),
  );
  const toolkit = yield* PullRequestsToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(PullRequestsHandlers.layer).pipe(
        Layer.provide(layerDependencies),
      ),
    ),
  );
  const call = <Name extends keyof typeof PullRequestsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["pull-requests"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof PullRequestsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(layerDependencies),
    );
  return { commands, guideRequests, call, workflowRunReads, usage };
});

const watchFields = (run: ThreadWorkflowRunWatch): ThreadWorkflowRunWatch => ({
  host: run.host,
  repository: run.repository,
  runId: run.runId,
  url: run.url,
  name: run.name,
  startedAt: run.startedAt,
});

describe("repository identity refresh", () => {
  it.effect.each([
    "watch_workflow_run",
    "link_pull_request",
    "watch_pull_request",
    "unwatch_pull_request",
    "unlink_pull_request",
    "unwatch_workflow_run",
  ] as const)("%s resolves a host before the identity cache has a value", (tool) =>
    Effect.gen(function* () {
      const enrichment = yield* ProjectEnrichment.make().pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
              resolve: () => Effect.succeed(makeProject().repositoryIdentity ?? null),
            }),
            Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({
              resolvePath: () => Effect.succeed(null),
            }),
          ),
        ),
      );
      expect((yield* enrichment.peek("/workspace/project")).repositoryIdentity).toBeNull();
      const harness = yield* makeHarness({ enrichment, workflowRun: runningRun });
      const result = yield* harness.call(tool, {
        repository: "t3tools/t3code",
        number: 123,
        runId: 9001,
      });
      expect(result).toMatchObject({ host: "github.com", repository: "t3tools/t3code" });
    }),
  );
  it.effect("finds the guide project before the identity cache has a value", () =>
    Effect.gen(function* () {
      const enrichment = yield* ProjectEnrichment.make().pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
              resolve: () => Effect.succeed(makeProject().repositoryIdentity ?? null),
            }),
            Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({
              resolvePath: () => Effect.succeed(null),
            }),
          ),
        ),
      );
      const harness = yield* makeHarness({ enrichment });
      const result = yield* harness.call("write_pull_request_guides", {
        pullRequests: [{ repository: "t3tools/t3code", number: 123 }],
      });
      expect(result.guides.map((guide) => guide.outcome)).toEqual(["started"]);
      expect(yield* Ref.get(harness.guideRequests)).toMatchObject([
        { projectId: PROJECT_ID, number: 123 },
      ]);
    }),
  );
  it.effect.each([false, true])("returns the host-required error (lookup failure: %s)", (failure) =>
    Effect.gen(function* () {
      const enrichment = yield* ProjectEnrichment.make().pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
              resolve: () =>
                failure ? Effect.die("synthetic lookup failure") : Effect.succeed(null),
            }),
            Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({
              resolvePath: () => Effect.succeed(null),
            }),
          ),
        ),
      );
      const harness = yield* makeHarness({ enrichment });
      const error = yield* harness
        .call("watch_workflow_run", { repository: "t3tools/t3code", runId: 9001 })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestHostRequiredError" });
    }),
  );
});

describe("pull request toolkit handlers", () => {
  it.effect("refuses a credential without the pull-requests capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("list_thread_pull_requests", {}, ["preview"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "pull-requests",
        threadId: THREAD_ID,
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("points a bare thread uuid at the mcp: thread it belongs to", () =>
    Effect.gen(function* () {
      const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
      const harness = yield* makeHarness({
        thread: { ...makeThread([]), id: ThreadId.make(`mcp:${bareId}`) },
      });
      const error = yield* harness
        .call("link_pull_request", { threadId: bareId, number: 123 })
        .pipe(Effect.flip);
      expect(error.message).toBe(`Thread ${bareId} was not found. Did you mean \`mcp:${bareId}\`?`);
      expect(error).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "thread_not_found" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("links by URL with source agent on the token's thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("link_pull_request", {
        url: "https://github.com/T3Tools/T3Code/pull/123/files",
      });
      expect(result).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 123,
        url: "https://github.com/T3Tools/T3Code/pull/123/files",
        alreadyLinked: false,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.pull-request.link",
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 123,
          source: "agent",
        },
      ]);
    }),
  );

  it.effect("watching an unlinked pull request links it first", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("watch_pull_request", {
        url: "https://github.com/t3tools/t3code/pull/9",
      });
      expect(result).toMatchObject({ number: 9, watching: false, wasWatching: false });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.pull-request.watch",
          number: 9,
          watching: true,
          start: { failedChecks: [], passed: false, conflicting: false },
          link: { url: "https://github.com/t3tools/t3code/pull/9", source: "agent" },
        },
      ]);
      const unavailable = yield* makeHarness({
        detailFailure: new PullRequestUnavailableError({
          provider: SourceControlProviderKind.make("github"),
          requirement: "gh",
          reason: "cli-missing",
        }),
      });
      const failure = yield* unavailable
        .call("watch_pull_request", {
          url: "https://github.com/t3tools/t3code/pull/9",
        })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "PullRequestWatchFailedError" });
      expect(yield* Ref.get(unavailable.commands)).toEqual([]);
    }),
  );

  // The watch records only what the reply told, so anything else wakes the agent later.
  it.effect.each([
    {
      label: "failed while others run",
      atStart: { lint: "failure", build: "cancelled", test: "pending" },
      checksState: "failing",
      told: ["lint", "build"],
      later: { lint: "failure", build: "cancelled", test: "failure" },
      wakes: ["checks-failed"],
    },
    {
      label: "passing",
      atStart: { lint: "success", test: "success" },
      checksState: "passing",
      told: [],
      later: { lint: "success", test: "success" },
      wakes: [],
    },
    {
      label: "running",
      atStart: { lint: "success", test: "pending" },
      checksState: "pending",
      told: [],
      later: { lint: "success", test: "success" },
      wakes: ["checks-passed"],
    },
    {
      label: "unread",
      atStart: null,
      checksState: undefined,
      told: [],
      later: { lint: "failure", test: "success" },
      wakes: ["checks-failed", "conflicting"],
    },
  ] as const)("reports $label checks at the start and wakes only on news", (row) =>
    Effect.gen(function* () {
      const checksOf = (statuses: Record<string, PullRequestCheck["status"]>) =>
        Object.entries(statuses).map(([name, status]) => ({
          name,
          status,
          description: null,
          url: null,
        }));
      const harness = yield* makeHarness(
        row.atStart === null
          ? {
              detailFailure: new PullRequestOperationError({
                operation: "detail",
                detail: "Unavailable",
              }),
            }
          : { checks: checksOf(row.atStart) },
      );
      const result = yield* harness.call("watch_pull_request", {
        url: "https://github.com/t3tools/t3code/pull/9",
      });
      expect(result.checksState).toBe(row.checksState);
      expect(result.failedChecks?.map((check) => check.name)).toEqual(
        row.told.length > 0 ? row.told : undefined,
      );
      if (row.checksState === "passing") expect(result.next).toBe(CHECKS_ALREADY_PASSED_WATCH_NEXT);
      if (row.atStart === null) expect(result.next).toContain("could not read");
      const [command] = yield* Ref.get(harness.commands);
      const start = command?.type === "thread.pull-request.watch" ? command.start : undefined;
      assert(start !== undefined);
      const later = evaluatePullRequestWatch(
        start,
        pullRequestDetail(checksOf(row.later), row.atStart === null ? "conflicting" : "mergeable"),
        [],
        Date.parse(start.startedAt) + 60_000,
      );
      expect(later.changes.map((change) => change.kind)).toEqual(row.wakes);
      if (row.wakes[0] === "checks-failed") {
        expect(later.changes[0]).toMatchObject({
          failed: [{ name: row.label === "unread" ? "lint" : "test" }],
        });
      }
    }),
  );

  it.effect("reports runs already awaiting approval and an existing conflict", () =>
    Effect.gen(function* () {
      const awaiting = {
        name: "e2e",
        status: "action-required" as const,
        description: null,
        url: "https://github.com/t3tools/t3code/actions/runs/7",
      };
      const harness = yield* makeHarness({
        checks: [awaiting, { name: "test", status: "pending", description: null, url: null }],
        mergeability: "conflicting",
      });
      const result = yield* harness.call("watch_pull_request", {
        url: "https://github.com/t3tools/t3code/pull/9",
      });
      expect(result).toMatchObject({ awaitingApproval: [awaiting], conflicting: true });
      expect(result.next).toContain("require action");
      expect(result.next).toContain("e2e");
      expect(result.next).toContain("conflicts with its base");
    }),
  );

  it.effect("refuses to watch a merged pull request and stops an existing watch", () =>
    Effect.gen(function* () {
      const watch = {
        startedAt: "2026-08-20T00:00:00.000Z",
        headSha: null,
        failedChecks: [],
        passed: false,
        passedChecks: [],
        remarksThrough: "2026-08-20T00:00:00.000Z",
        remarkIds: [],
        conflicting: false,
        wakes: 0,
      };
      const merged = makeLink(1, { headBranch: "done" });
      const harness = yield* makeHarness({
        thread: makeThread([
          { ...merged, snapshot: merged.snapshot && { ...merged.snapshot, state: "merged" } },
          makeLink(2, { headBranch: "idle" }),
          makeLink(3, { headBranch: "watched", watch }),
        ]),
      });
      const error = yield* harness
        .call("watch_pull_request", { repository: "t3tools/t3code", number: 1 })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestNotOpenError", state: "merged" });
      expect(
        yield* harness.call("unwatch_pull_request", { repository: "t3tools/t3code", number: 3 }),
      ).toMatchObject({ wasWatching: true });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.watch", number: 3, watching: false },
      ]);
    }),
  );

  it.effect("watches a pull request saved as closed, since it may have reopened", () =>
    Effect.gen(function* () {
      const closed = makeLink(1, { headBranch: "closed" });
      const harness = yield* makeHarness({
        thread: makeThread([
          { ...closed, snapshot: closed.snapshot && { ...closed.snapshot, state: "closed" } },
        ]),
      });
      yield* harness.call("watch_pull_request", { repository: "t3tools/t3code", number: 1 });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.watch", number: 1, watching: true },
      ]);
    }),
  );

  it.effect("refuses a watch from a subagent thread, whose parent owns the pull request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: {
          ...makeThread([makeLink(1, { headBranch: "feature" })]),
          lineage: {
            rootThreadId: ThreadId.make("parent"),
            parentThreadId: ThreadId.make("parent"),
            relationshipToParent: "subagent",
          },
        },
      });
      const error = yield* harness
        .call("watch_pull_request", { repository: "t3tools/t3code", number: 1 })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestWatchFromSubagentError" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("asks a subagent thread to end with its PR report after it links", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: {
          ...makeThread([]),
          lineage: {
            rootThreadId: ThreadId.make("parent"),
            parentThreadId: ThreadId.make("parent"),
            relationshipToParent: "subagent",
          },
        },
      });
      const result = yield* harness.call("link_pull_request", {
        url: "https://github.com/t3tools/t3code/pull/124",
      });
      expect(result).toMatchObject({ number: 124, next: CHILD_PULL_REQUEST_REPORT_NEXT });
    }),
  );

  it.effect("canonicalizes GitCafe links independently of the thread's project host", () =>
    Effect.gen(function* () {
      for (const host of ["git.cafe", "staging.git.cafe"]) {
        for (const project of [makeProject(), makeProject(null)]) {
          for (const target of [
            { host, repository: "PingDotGG/T3Code", number: 21353 },
            { url: `https://${host}/PingDotGG/T3Code/pull/21353` },
            { url: `https://${host}/PingDotGG/T3Code/pulls/21353` },
          ]) {
            const harness = yield* makeHarness({ project });
            const result = yield* harness.call("link_pull_request", target);
            const url = `https://${host}/pingdotgg/t3code/pulls/21353`;
            expect(result).toMatchObject({
              host,
              repository: "pingdotgg/t3code",
              number: 21353,
              url,
            });
            expect(yield* Ref.get(harness.commands)).toMatchObject([
              {
                type: "thread.pull-request.link",
                host,
                repository: "pingdotgg/t3code",
                number: 21353,
                url,
              },
            ]);
          }
        }
      }
    }),
  );

  it.effect("builds the URL in the project host's own shape", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        project: makeProject({
          canonicalKey: "gitlab.com/group/sub/project",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "git@gitlab.com:group/sub/project.git",
          },
          provider: SourceControlProviderKind.make("gitlab"),
          displayName: "group/sub/project",
        }),
      });
      const result = yield* harness.call("link_pull_request", {
        repository: "group/sub/project",
        number: 42,
      });
      expect(result.url).toBe("https://gitlab.com/group/sub/project/-/merge_requests/42");
      expect(result.host).toBe("gitlab.com");
      const other = yield* harness.call("link_pull_request", {
        host: "gitlab.example.test",
        repository: "team/repo",
        number: 7,
      });
      expect(other.url).toBe("https://gitlab.example.test/team/repo/-/merge_requests/7");
      const onGitHub = yield* harness.call("link_pull_request", {
        host: "github.com",
        repository: "acme/web",
        number: 9,
      });
      expect(onGitHub.url).toBe("https://github.com/acme/web/pull/9");
    }),
  );

  it.effect("links a URL but not a bare number when the project's host is unknown", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        project: makeProject({
          canonicalKey: "scm.example.test/tfs/collection/project/_git/repo",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "http://dummy:secret@scm.example.test:8080/tfs/Collection/Project/_git/Repo",
          },
          provider: SourceControlProviderKind.make("unknown"),
          displayName: "tfs/collection/project/_git/repo",
        }),
      });
      const error = yield* harness
        .call("link_pull_request", { repository: "tfs/Collection/Project/_git/Repo", number: 124 })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestUrlUnavailableError" });

      const supplied = "https://scm.example.test/tfs/Collection/Project/_git/Repo/pullrequest/123";
      const fromUrl = yield* harness.call("link_pull_request", { url: supplied });
      expect(fromUrl).toEqual({
        host: "scm.example.test",
        repository: "tfs/collection/project/_git/repo",
        number: 123,
        url: supplied,
        alreadyLinked: false,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.link", number: 123, url: supplied },
      ]);
    }),
  );

  it.effect("treats a duplicate link as alreadyLinked rather than an error", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(123)]),
        reject: (command) =>
          command.type === "thread.pull-request.link" ? "already linked" : null,
      });
      const result = yield* harness.call("link_pull_request", {
        url: "https://github.com/t3tools/t3code/pull/123",
      });
      expect(result.alreadyLinked).toBe(true);
    }),
  );

  it.effect("unlinks a linked pull request and reports a missing one as wasLinked=false", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(5)]),
        reject: (command) =>
          command.type === "thread.pull-request.unlink" && command.number !== 5
            ? "not linked"
            : null,
      });
      const linked = yield* harness.call("unlink_pull_request", {
        repository: "t3tools/t3code",
        number: 5,
      });
      expect(linked).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 5,
        wasLinked: true,
      });
      const missing = yield* harness.call("unlink_pull_request", {
        url: "https://github.com/t3tools/t3code/pull/9",
      });
      expect(missing.wasLinked).toBe(false);
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.unlink", number: 5 },
      ]);
    }),
  );

  it.effect("reports a dismissed stack member as not linked and leaves it dismissed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(9, { source: "stack-dismissed" })]),
      });
      const result = yield* harness.call("unlink_pull_request", {
        repository: "t3tools/t3code",
        number: 9,
      });
      expect(result.wasLinked).toBe(false);
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("links several pull requests in one call", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(1), { ...makeLink(2), source: "stack-dismissed" }]),
      });
      const url = (number: number) => `https://github.com/t3tools/t3code/pull/${number}`;
      const result = yield* harness.call("link_pull_requests", {
        urls: [url(1), url(2), url(3), url(3), "https://example.com/not-a-pr"],
      });
      expect(result).toEqual({
        linked: [{ host: "github.com", repository: "t3tools/t3code", numbers: [2, 3] }],
        alreadyLinked: [{ host: "github.com", repository: "t3tools/t3code", numbers: [1] }],
        linkedCount: 3,
        invalidUrls: ["https://example.com/not-a-pr"],
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.link", number: 2, source: "agent" },
        { type: "thread.pull-request.link", number: 3, source: "agent" },
      ]);
    }),
  );

  it.effect("unlinks every visible pull request in the given states in one call", () =>
    Effect.gen(function* () {
      const withState = (number: number, state: "open" | "closed" | "merged") => {
        const link = makeLink(number, { headBranch: `branch-${number}` });
        return { ...link, snapshot: { ...link.snapshot!, state } };
      };
      const harness = yield* makeHarness({
        thread: makeThread([
          withState(1, "merged"),
          withState(2, "open"),
          withState(3, "closed"),
          makeLink(4),
          { ...withState(5, "merged"), source: "stack-dismissed" },
        ]),
      });
      const result = yield* harness.call("unlink_pull_requests", {
        states: ["closed", "merged"],
      });
      expect(result).toEqual({
        unlinked: [
          { host: "github.com", repository: "t3tools/t3code", state: "merged", numbers: [1] },
          { host: "github.com", repository: "t3tools/t3code", state: "closed", numbers: [3] },
        ],
        unlinkedCount: 2,
        remaining: 2,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.unlink", number: 1 },
        { type: "thread.pull-request.unlink", number: 3 },
      ]);
    }),
  );

  it("reports an older Forgejo link's HTTP port when listing thread links", () => {
    const result = listThreadPullRequests(
      makeThread([
        makeLink(42, {
          host: "forge.example",
          url: "http://forge.example:3000/t3tools/t3code/pulls/42",
        }),
      ]),
    );
    expect(result.pullRequests[0]?.host).toBe("forge.example:3000");
  });

  it.effect("lists visible links with host state and derived chain order", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([
          makeLink(3, { headBranch: "feat-c", baseBranch: "feat-b", source: "agent" }),
          makeLink(1, { headBranch: "feat-a", baseBranch: "main", source: "created" }),
          makeLink(2, { headBranch: "feat-b", baseBranch: "feat-a", source: "agent" }),
          makeLink(9, { source: "stack-dismissed" }),
          makeLink(10),
        ]),
      });
      const result = yield* harness.call("list_thread_pull_requests", {});
      expect(result.pullRequests.map((entry) => entry.number)).toEqual([3, 1, 2, 10]);
      expect(result.pullRequests[0]).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 3,
        url: "https://github.com/t3tools/t3code/pull/3",
        source: "agent",
        watching: false,
        state: "open",
        title: "PR 3",
        headBranch: "feat-c",
        baseBranch: "feat-b",
        isDraft: false,
        stack: { kind: "derived", position: 3, size: 3 },
      });
      expect(result.pullRequests[3]).toMatchObject({
        number: 10,
        state: null,
        title: null,
        headBranch: null,
        stack: null,
      });
      expect(result.chains).toEqual([
        { kind: "derived", numbers: [1, 2, 3] },
        { kind: "derived", numbers: [10] },
      ]);
    }),
  );
});

const runningRun: ProviderWorkflowRun = {
  name: "Deploy #41",
  url: "https://github.com/t3tools/t3code/actions/runs/9001",
  completed: false,
  conclusion: null,
  headBranch: "main",
  headSha: "a".repeat(40),
  event: "push",
  reviewableEnvironments: [],
  failedJobs: [],
};

describe("workflow run watches", () => {
  it("parses run and job URLs", () => {
    expect(
      parseWorkflowRunUrl("https://github.com/T3Tools/T3Code/actions/runs/9001/job/77"),
    ).toEqual({ host: "github.com", repository: "t3tools/t3code", runId: 9001 });
    expect(parseWorkflowRunUrl("https://github.com/t3tools/t3code/pull/12")).toBeNull();
    expect(parseWorkflowRunUrl("not a url")).toBeNull();
  });

  it.effect("watches a running run under the name the host reports", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ workflowRun: runningRun });
      const result = yield* harness.call("watch_workflow_run", {
        repository: "T3Tools/T3Code",
        runId: 9001,
      });
      expect(result).toMatchObject({
        host: "github.com",
        repository: "t3tools/t3code",
        runId: 9001,
        name: "Deploy #41",
        watching: true,
        wasWatching: false,
        conclusion: null,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.workflow-run.watch",
          host: "github.com",
          repository: "t3tools/t3code",
          runId: 9001,
          watching: true,
          run: { url: runningRun.url, name: "Deploy #41" },
        },
      ]);
      expect(harness.usage).toEqual([]);
    }),
  );

  it.effect("reports a run that already completed instead of watching it", () =>
    Effect.gen(function* () {
      const failedJobs = [{ name: "build", conclusion: "failure", url: null }];
      const harness = yield* makeHarness({
        workflowRun: { ...runningRun, completed: true, conclusion: "failure", failedJobs },
      });
      const result = yield* harness.call("watch_workflow_run", { url: runningRun.url });
      expect(result).toMatchObject({ watching: false, conclusion: "failure", failedJobs });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
      expect(harness.usage).toEqual([]);
    }),
  );

  it.effect("fails without watching when the run cannot be read", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("watch_workflow_run", { url: runningRun.url })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "WorkflowRunReadFailedError" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
      expect(harness.usage).toEqual([]);
    }),
  );

  it.effect("preserves a refusal before reading a workflow run", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ workflowRun: runningRun, callerIdle: true });
      const error = yield* harness
        .call("watch_workflow_run", { url: runningRun.url })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "OrchestratorMcpFailure" });
      expect(yield* Ref.get(harness.workflowRunReads)).toEqual([]);
      expect(harness.usage).toEqual([]);
    }),
  );

  it.effect("stops a watch without reading the run", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        workflowRuns: [
          {
            host: "github.com",
            repository: "t3tools/t3code",
            runId: 9001,
            url: runningRun.url,
            name: "Deploy #41",
            startedAt: "2026-08-20T00:00:00.000Z",
          },
        ],
      });
      const result = yield* harness.call("unwatch_workflow_run", { url: runningRun.url });
      expect(result).toMatchObject({ watching: false, wasWatching: true, name: "Deploy #41" });
      expect(yield* Ref.get(harness.workflowRunReads)).toEqual([]);
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.workflow-run.watch", runId: 9001, watching: false },
      ]);
      expect(harness.usage).toEqual([]);
    }),
  );
});

describe("listThreadPullRequests", () => {
  it("reports a native stack position for each member", () => {
    const stack = {
      kind: "native" as const,
      id: "stack-1",
      number: 1,
      url: "https://github.com/t3tools/t3code/stack/1",
      base: "main",
      layers: [
        { number: 1, headBranch: "a", state: "open" as const },
        { number: 2, headBranch: "b", state: "open" as const },
      ],
    };
    const result = listThreadPullRequests({
      pullRequests: [
        makeLink(2, { stack, source: "stack" }),
        makeLink(1, { stack, source: "created" }),
      ],
    });
    expect(result.pullRequests.map((entry) => [entry.number, entry.stack])).toEqual([
      [2, { kind: "native", position: 2, size: 2 }],
      [1, { kind: "native", position: 1, size: 2 }],
    ]);
    expect(result.chains).toEqual([{ kind: "native", numbers: [1, 2] }]);
  });

  it("gives pull requests built on the same one the same position", () => {
    const result = listThreadPullRequests({
      pullRequests: [
        makeLink(1, { headBranch: "feat-a", baseBranch: "main" }),
        makeLink(2, { headBranch: "feat-b", baseBranch: "feat-a" }),
        makeLink(3, { headBranch: "feat-c", baseBranch: "feat-a" }),
      ],
    });
    expect(result.pullRequests.map((entry) => [entry.number, entry.stack])).toEqual([
      [1, { kind: "derived", position: 1, size: 3 }],
      [2, { kind: "derived", position: 2, size: 3 }],
      [3, { kind: "derived", position: 2, size: 3 }],
    ]);
    expect(result.chains).toEqual([{ kind: "derived", numbers: [1, 2, 3] }]);
  });
});

describe("pull request guide tools", () => {
  it.effect(
    "writes guides through the project whose checkout is each pull request's repository",
    () =>
      Effect.gen(function* () {
        const other = {
          ...makeProject({
            canonicalKey: "github.com/acme/web",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "git@github.com:acme/web.git",
            },
            provider: SourceControlProviderKind.make("github"),
            displayName: "acme/web",
            owner: "acme",
            name: "web",
          }),
          id: ProjectId.make("project-web"),
        };
        const harness = yield* makeHarness({ projects: [makeProject(), other] });
        const result = yield* harness.call("write_pull_request_guides", {
          pullRequests: [
            { url: "https://github.com/acme/web/pull/7" },
            { repository: "t3tools/t3code", number: 12 },
            { url: "https://github.com/someone/else/pull/1" },
          ],
        });
        expect(
          result.guides.map((guide) => [guide.repository, guide.number, guide.outcome]),
        ).toEqual([
          ["acme/web", 7, "started"],
          ["t3tools/t3code", 12, "started"],
          ["someone/else", 1, "failed"],
        ]);
        expect(result.guides[2]?.detail).toContain("No project in this environment");
        expect(
          (yield* Ref.get(harness.guideRequests)).map((ref) => [ref.projectId, ref.number]),
        ).toEqual([
          ["project-web", 7],
          [PROJECT_ID, 12],
        ]);
      }),
  );

  it.effect("reports an unreadable entry on its own and still writes the rest of the batch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("write_pull_request_guides", {
        pullRequests: [
          { url: "https://example.com/not-a-pull-request" },
          { repository: "t3tools/t3code" },
          { repository: "t3tools/t3code", number: 5 },
        ],
      });
      expect(result.guides.map((guide) => guide.outcome)).toEqual(["failed", "failed", "started"]);
      expect(result.guides[0]?.detail).toContain("not a recognised pull request URL");
      expect(result.guides[1]?.detail).toContain("Pass either url");
      expect((yield* Ref.get(harness.guideRequests)).map((ref) => ref.number)).toEqual([5]);
    }),
  );

  it.effect("finds an Azure DevOps checkout for a pull request named by its full path", () =>
    Effect.gen(function* () {
      const azure = {
        ...makeProject({
          canonicalKey: "dev.azure.com/org/project/_git/web",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://dev.azure.com/org/project/_git/web",
          },
          provider: SourceControlProviderKind.make("azure-devops"),
          displayName: "org/project/_git/web",
          owner: "org",
          name: "web",
        }),
        id: ProjectId.make("project-azure"),
      };
      const harness = yield* makeHarness({ projects: [makeProject(), azure] });
      const result = yield* harness.call("write_pull_request_guides", {
        pullRequests: [{ host: "dev.azure.com", repository: "org/project/_git/web", number: 9 }],
      });
      expect(result.guides.map((guide) => guide.outcome)).toEqual(["started"]);
      expect((yield* Ref.get(harness.guideRequests)).map((ref) => ref.projectId)).toEqual([
        "project-azure",
      ]);
    }),
  );
});
