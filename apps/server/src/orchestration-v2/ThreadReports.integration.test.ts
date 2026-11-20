import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2ThreadReportTarget,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { reportRecipient } from "./ProjectCoordinator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { answerNotesText, checkThreadReport } from "./ThreadReports.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const launcherId = ThreadId.make("thread:report-launcher");
const launchedId = ThreadId.make("thread:report-launched");
const reportTo: OrchestrationV2ThreadReportTarget = { threadId: launcherId };

const makeHelpers = (input: {
  readonly name: string;
  readonly cwd: string;
  readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
  readonly started: ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>;
  readonly coordinator: boolean;
}) => {
  const { name, cwd, events, started } = input;
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const settings = yield* ServerSettings.ServerSettingsService;
    const projectId = ProjectId.make(`project:${name}`);
    const setCoordinator = (threadId: ThreadId | null) =>
      settings.updateSettings({
        projectCoordinatorsEnabled: true,
        projectCoordinators: { [projectId]: threadId === null ? null : { threadId } },
      });
    const create = (
      threadId: ThreadId,
      target?: OrchestrationV2ThreadReportTarget,
      options?: { readonly byPerson?: boolean },
    ) =>
      orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId,
        title: threadId === launcherId ? "Coordinator" : "Fix the login page",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        createdBy: options?.byPerson === true ? "user" : "agent",
        creationSource: options?.byPerson === true ? "web" : "mcp",
        ...(target === undefined ? {} : { reportTo: target }),
      });
    yield* create(launcherId);
    if (input.coordinator) yield* setCoordinator(launcherId);
    yield* create(launchedId, reportTo);

    const send = (
      threadId: ThreadId,
      text: string,
      options?: {
        readonly sender?: "user" | "agent";
        readonly reportAnswer?: {
          readonly messageId: MessageId;
          readonly key: string;
          readonly version: number;
        };
      },
    ) =>
      Effect.gen(function* () {
        const before = started.length;
        const recorded = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.threadId === threadId &&
              event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const sender = options?.sender ?? "agent";
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`send:${threadId}:${text}`),
          threadId,
          messageId: MessageId.make(`message:${threadId}:${text}`),
          text,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: sender,
          creationSource: sender === "agent" ? "mcp" : "web",
          ...(options?.reportAnswer === undefined ? {} : { reportAnswer: options.reportAnswer }),
        });
        yield* worker.drain();
        yield* Fiber.join(recorded);
        assert.equal(started.length, before + 1);
        return started.at(-1)!;
      });

    const endTurn = (
      turn: ProviderAdapter.ProviderAdapterV2TurnInput,
      outcome: "completed" | "failed",
    ) =>
      Effect.gen(function* () {
        const projection = yield* orchestrator.getThreadProjection(turn.threadId);
        const providerTurn = projection.providerTurns.find(
          (candidate) => candidate.runAttemptId === turn.attemptId,
        )!;
        const settled = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === turn.runId &&
              (event.payload.status === "waiting" ||
                event.payload.status === "completed" ||
                event.payload.status === "failed"),
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...providerTurn, status: outcome, completedAt: yield* DateTime.now },
        });
        const terminal = {
          type: "turn.terminal",
          driver,
          providerThreadId: providerTurn.providerThreadId,
          providerTurnId: providerTurn.id,
          runOrdinal: turn.runOrdinal,
          threadDisposition: "reusable",
        } as const;
        yield* Queue.offer(
          events,
          outcome === "failed"
            ? {
                ...terminal,
                status: "failed",
                failureItemOrdinal: 1,
                failure: makeProviderFailure({
                  message: "Sign-in expired.",
                  code: "auth_required",
                  class: "permission_error",
                }),
              }
            : { ...terminal, status: "completed", failure: null },
        );
        yield* Fiber.join(settled);
        yield* worker.drain();
      });

    const askQuestion = (
      turn: ProviderAdapter.ProviderAdapterV2TurnInput,
      id: string,
      status: "pending" | "resolved",
      messageMode = false,
    ) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const seen = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime-request.updated" &&
              event.payload.id === RuntimeRequestId.make(id) &&
              event.payload.status === status,
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Queue.offer(events, {
          type: "runtime_request.updated",
          driver,
          threadId: turn.threadId,
          runtimeRequest: {
            id: RuntimeRequestId.make(id),
            nodeId: turn.rootNodeId ?? NodeId.make("node:unused"),
            providerTurnId: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
            nativeRequestRef: null,
            kind: "user_input",
            status,
            responseCapability: messageMode
              ? { type: "message" }
              : {
                  type: "live",
                  providerSessionId: turn.providerThread.providerSessionId!,
                },
            createdAt: now,
            resolvedAt: status === "pending" ? null : now,
          },
        });
        yield* Fiber.join(seen);
        yield* worker.drain();
      });

    /** A pending question or approval with the timeline item a person reads it from. */
    const ask = (
      turn: ProviderAdapter.ProviderAdapterV2TurnInput,
      id: string,
      kind: "question" | "approval",
      messageMode = false,
    ) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const requestId = RuntimeRequestId.make(id);
        const nodeId = turn.rootNodeId ?? NodeId.make("node:unused");
        const providerTurnId = ProviderTurnId.make(`provider-turn:${turn.attemptId}`);
        const seen = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "runtime-request.updated" && event.payload.id === requestId,
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Queue.offer(events, {
          type: "turn_item.updated",
          driver,
          turnItem: {
            id: TurnItemId.make(`turn-item:${id}`),
            threadId: turn.threadId,
            runId: turn.runId,
            nodeId,
            providerThreadId: turn.providerThread.id,
            providerTurnId,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 50,
            status: "waiting",
            title: kind === "question" ? "Question" : "Run vp i",
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            ...(kind === "question"
              ? {
                  type: "user_input_request" as const,
                  requestId,
                  questions: [
                    { id: "db", header: "Database", question: "Which database?", options: [] },
                  ],
                }
              : {
                  type: "approval_request" as const,
                  requestId,
                  requestKind: "command" as const,
                  prompt: "Run vp i",
                }),
          },
        });
        yield* Queue.offer(events, {
          type: "runtime_request.updated",
          driver,
          threadId: turn.threadId,
          runtimeRequest: {
            id: requestId,
            nodeId,
            providerTurnId,
            nativeRequestRef: null,
            kind: kind === "question" ? "user_input" : "command",
            status: "pending",
            responseCapability: messageMode
              ? { type: "message" }
              : { type: "live", providerSessionId: turn.providerThread.providerSessionId! },
            createdAt: now,
            resolvedAt: null,
          },
        });
        yield* Fiber.join(seen);
        yield* worker.drain();
      });

    const reports = () =>
      orchestrator.getThreadProjection(launcherId).pipe(
        Effect.map((projection) =>
          projection.messages.flatMap((message) =>
            message.notification?.source.kind === "launched_thread"
              ? [
                  {
                    id: message.id,
                    text: message.text,
                    outcome: message.notification.outcome,
                  },
                ]
              : [],
          ),
        ),
      );

    return {
      orchestrator,
      settings,
      worker,
      started,
      create,
      setCoordinator,
      send,
      endTurn,
      askQuestion,
      ask,
      reports,
    };
  });
};
type ReportHarness = Effect.Success<ReturnType<typeof makeHelpers>>;

const harness = <A, E>(
  name: string,
  test: (helpers: ReportHarness) => Effect.Effect<A, E, Scope.Scope>,
  options?: { readonly coordinator?: boolean },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(name);
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const started: Array<ProviderAdapter.ProviderAdapterV2TurnInput> = [];
      const providerThread = (threadId: ThreadId, now: DateTime.Utc) => ({
        id: ProviderThreadId.make(`provider-thread:${threadId}`),
        driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" as const },
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      });
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const startTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
              Effect.gen(function* () {
                started.push(turn);
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                    providerThreadId: turn.providerThread.id,
                    nodeId: turn.rootNodeId,
                    runAttemptId: turn.attemptId,
                    nativeTurnRef: {
                      driver,
                      nativeId: `native:${turn.attemptId}`,
                      strength: "strong",
                    },
                    ordinal: turn.providerTurnOrdinal,
                    status: "running",
                    startedAt: now,
                    completedAt: null,
                  },
                });
              });
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  ...providerThread(threadId, now),
                  providerSessionId: input.providerSessionId,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              forkThread: () => Effect.die("unused"),
              startTurn,
              compactThread: startTurn,
              steerTurn: () => Effect.die("unused"),
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
            };
          }),
      };
      const settingsLayer = ServerSettings.layerTest({
        responseStreamingMode: "turn",
        coordinatorReportsEnabled: true,
      }).pipe(Layer.orDie);
      return yield* makeHelpers({
        name,
        cwd,
        events,
        started,
        coordinator: options?.coordinator === true,
      }).pipe(
        Effect.flatMap(test),
        Effect.provide(
          Layer.merge(
            ProviderReplayHarness.layerWithRegistry(
              { name },
              ProviderAdapterRegistry.layerSingle(adapter),
              { runEffectWorker: false, serverSettingsLayer: settingsLayer },
            ),
            settingsLayer,
          ),
        ),
      );
    }),
  );

it.effect("a finished turn with nothing pending wakes the launcher once", () =>
  harness("report-result", ({ started, send, endTurn, reports, worker }) =>
    Effect.gen(function* () {
      const turn = yield* send(launchedId, "Fix the login page");
      assert.include(turn.message.text, launcherId, "the first turn names the launcher");
      yield* endTurn(turn, "completed");
      const delivered = yield* reports();
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0]?.outcome, "completed");
      assert.include(delivered[0]?.text ?? "", "Fix the login page");
      const wake = started.find((candidate) => candidate.threadId === launcherId);
      assert.isDefined(wake, "the report starts a turn on the idle launcher");
      yield* worker.drain();
      assert.equal((yield* reports()).length, 1);

      // Later turns do not repeat the note.
      const next = yield* send(launchedId, "Keep going");
      assert.notInclude(next.message.text, launcherId);
    }),
  ),
);

it.effect("a turn a person started stays quiet, but its failure still reports", () =>
  harness("report-person", ({ send, endTurn, reports }) =>
    Effect.gen(function* () {
      const quiet = yield* send(launchedId, "Tweak the copy", { sender: "user" });
      yield* endTurn(quiet, "completed");
      assert.equal((yield* reports()).length, 0);

      const failed = yield* send(launchedId, "Try again", { sender: "user" });
      yield* endTurn(failed, "failed");
      const delivered = yield* reports();
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0]?.outcome, "failed");
      assert.include(delivered[0]?.text ?? "", "Sign-in expired.");
    }),
  ),
);

it.effect("a turn with a pull request watch on stays quiet", () =>
  harness("report-watch", ({ orchestrator, send, endTurn, reports }) =>
    Effect.gen(function* () {
      const turn = yield* send(launchedId, "Open the PR");
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("watch-pr"),
        threadId: launchedId,
        host: "github.com",
        repository: "acme/app",
        number: 7,
        watching: true,
        link: { url: "https://github.com/acme/app/pull/7", source: "agent" },
      });
      yield* endTurn(turn, "completed");
      assert.equal((yield* reports()).length, 0);
    }),
  ),
);

it.effect("a question stays between the thread and a person for two minutes", () =>
  harness("report-blocked", ({ send, askQuestion, reports, worker }) =>
    Effect.gen(function* () {
      const turn = yield* send(launchedId, "Ship it");
      yield* askQuestion(turn, "request:quick", "pending");
      yield* TestClock.adjust("1 minute");
      yield* worker.drain();
      assert.equal((yield* reports()).length, 0, "not reported inside the grace period");
      yield* askQuestion(turn, "request:quick", "resolved");
      yield* TestClock.adjust("2 minutes");
      yield* worker.drain();
      assert.equal((yield* reports()).length, 0, "answered in time, so nothing to report");

      yield* askQuestion(turn, "request:stuck", "pending");
      yield* TestClock.adjust("2 minutes");
      yield* worker.drain();
      const delivered = yield* reports();
      assert.equal(delivered.length, 1);
      assert.include(delivered[0]?.text ?? "", "request:stuck");
      assert.include(delivered[0]?.text ?? "", "t3_pending_request");
    }),
  ),
);

it.effect("a completed turn with an unanswered question tells its launcher how to answer", () =>
  harness("report-ended-question", ({ send, askQuestion, endTurn, reports }) =>
    Effect.gen(function* () {
      const turn = yield* send(launchedId, "Ship it");
      yield* askQuestion(turn, "request:ended", "pending", true);
      yield* endTurn(turn, "completed");
      const delivered = yield* reports();
      assert.equal(delivered.length, 1);
      assert.include(delivered[0]!.text, "request:ended");
      assert.include(delivered[0]!.text, "action respond");
      assert.include(delivered[0]!.text, "t3_thread_send will not answer");
      assert.notInclude(delivered[0]!.text, "nothing else pending");
    }),
  ),
);

it.effect("a blocked report still queued is withdrawn once the question is answered", () =>
  harness("report-withdraw", ({ orchestrator, send, askQuestion, reports, worker }) =>
    Effect.gen(function* () {
      yield* send(launcherId, "Coordinate the batch");
      const turn = yield* send(launchedId, "Ship it");
      yield* askQuestion(turn, "request:withdrawn", "pending");
      yield* TestClock.adjust("2 minutes");
      yield* worker.drain();
      const [report] = yield* reports();
      assert.isDefined(report);
      const queued = () =>
        orchestrator
          .getThreadProjection(launcherId)
          .pipe(
            Effect.map(
              (projection) =>
                projection.runs.find((run) => run.userMessageId === report!.id)?.status,
            ),
          );
      assert.equal(yield* queued(), "queued", "the busy launcher holds the report");
      yield* askQuestion(turn, "request:withdrawn", "resolved");
      assert.equal(yield* queued(), "cancelled");
    }),
  ),
);

it.effect("a stopped target and an archived or person-settled launcher hear nothing", () =>
  harness("report-stopped", ({ orchestrator, send, endTurn, reports }) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle-launcher"),
        threadId: launcherId,
      });
      const toSettled = yield* send(launchedId, "First");
      yield* endTurn(toSettled, "completed");
      assert.equal((yield* reports()).length, 0, "a person settled the launcher");

      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("unsettle-launcher"),
        threadId: launcherId,
        reason: "user",
      });
      yield* orchestrator.dispatch({
        type: "thread.report-target.clear",
        commandId: CommandId.make("stop-reports"),
        threadId: launchedId,
      });
      const afterStop = yield* send(launchedId, "Second");
      yield* endTurn(afterStop, "failed");
      assert.equal((yield* reports()).length, 0, "reporting was stopped");
    }),
  ),
);

it.effect("a run that already sent its own report does not report its result again", () =>
  harness("report-sent", ({ orchestrator, send, endTurn, reports }) =>
    Effect.gen(function* () {
      const turn = yield* send(launchedId, "Ship it");
      yield* orchestrator.dispatch({
        type: "thread.report-target.set",
        commandId: CommandId.make("report-sent"),
        threadId: launchedId,
        reportTo: { threadId: launcherId, sentInRunId: turn.runId },
      });
      yield* endTurn(turn, "completed");
      assert.equal((yield* reports()).length, 0);
    }),
  ),
);

it.effect(
  "coordinator reports persist versions, timeline order, and one prompted dismissal note",
  () =>
    harness("coordinator-reports", ({ orchestrator, send, endTurn }) =>
      Effect.gen(function* () {
        const count = (expected: number) =>
          Effect.gen(function* () {
            assert.equal(
              ProjectionStore.threadShellFromProjection(
                yield* orchestrator.getThreadProjection(launcherId),
              ).openReportQuestionCount,
              expected,
            );
            assert.equal(
              (yield* orchestrator.getThreadShell(launcherId))?.openReportQuestionCount,
              expected,
            );
            const snapshot = yield* orchestrator.getShellSnapshot();
            assert.equal(
              snapshot.threads.find((thread) => thread.id === launcherId)?.openReportQuestionCount,
              expected,
            );
          });
        const turn = yield* send(launcherId, "Review the release");
        const post = (id: string, key = "pr:214") =>
          orchestrator.dispatch({
            type: "report.post",
            commandId: CommandId.make(id),
            threadId: launcherId,
            messageId: MessageId.make(id),
            key,
            title: "Release",
            body: "Tests passed. Merge the release.",
            question: "Merge?",
            answers: ["Merge", "Wait"],
          });
        yield* post("report:first");
        yield* count(1);
        yield* post("report:second");
        yield* count(1);
        yield* post("report:third");
        yield* post("report:other", "issue:9");
        yield* count(2);
        const projection = yield* orchestrator.getThreadProjection(launcherId);
        const reports = projection.messages.filter((message) => message.report);
        assert.deepEqual(
          reports.map((message) => message.report!.version),
          [1, 2, 3, 1],
        );
        assert.isTrue(
          reports.every((message) => message.role === "assistant" && message.runId === turn.runId),
        );
        const items = projection.turnItems.filter((item) => item.type === "assistant_message");
        const prompt = projection.turnItems.find(
          (item) => item.type === "user_message" && item.runId === turn.runId,
        );
        assert.isDefined(prompt);
        assert.isAbove(items[0]!.ordinal, prompt!.ordinal);

        assert.deepEqual(
          items.map((item) => (item.type === "assistant_message" ? item.messageId : null)),
          reports.map((message) => message.id),
        );
        assert.isTrue(
          items.every((item, index) => index === 0 || item.ordinal > items[index - 1]!.ordinal),
        );
        yield* orchestrator.dispatch({
          type: "report.dismiss",
          commandId: CommandId.make("dismiss:third"),
          threadId: launcherId,
          messageId: MessageId.make("report:third"),
          key: "pr:214",
          version: 3,
        });
        yield* count(1);
        yield* endTurn(turn, "completed");
        const compact = yield* send(launcherId, "/compact");
        assert.notInclude(compact.message.text, "You dismissed the report");
        yield* endTurn(compact, "completed");
        const next = yield* send(launcherId, "Continue");
        assert.include(next.message.text, 'You dismissed the report "Release" (version 3).');
        yield* endTurn(next, "completed");
        const last = yield* send(launcherId, "Continue again");
        assert.notInclude(last.message.text, "You dismissed the report");
        const reportAnswer = {
          messageId: MessageId.make("report:other"),
          key: "issue:9",
          version: 1,
        };
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("report:answer"),
          threadId: launcherId,
          messageId: MessageId.make("answer:other"),
          text: "[Release, version 1] Merge",
          reportAnswer,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* count(0);
        const queued = (yield* orchestrator.getThreadProjection(launcherId)).runs.find(
          (run) => run.userMessageId === "answer:other",
        )!;
        assert.equal(queued.status, "queued");
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(launcherId)).messages.find(
            (message) => message.id === "answer:other",
          )?.reportAnswer,
          reportAnswer,
        );
        yield* orchestrator.dispatch({
          type: "queued-run.edit",
          commandId: CommandId.make("edit:answer"),
          threadId: launcherId,
          runId: queued.id,
          text: "[Release, version 1] Wait",
        });
        yield* count(0);
        yield* orchestrator.dispatch({
          type: "queued-run.edit",
          commandId: CommandId.make("edit:answer:away"),
          threadId: launcherId,
          runId: queued.id,
          text: "[Other report, version 1] Wait",
        });
        yield* count(1);
        assert.isUndefined(
          (yield* orchestrator.getThreadProjection(launcherId)).messages.find(
            (message) => message.id === "answer:other",
          )?.reportAnswer,
        );
        yield* orchestrator.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("cancel:answer"),
          threadId: launcherId,
          runId: queued.id,
        });
        yield* count(1);
        const window = yield* orchestrator.getThreadSnapshotWindow(launcherId, {
          rowLimit: 1,
          userTurnLimit: 1,
        });
        assert.deepEqual(
          window.projection.messages
            .filter((message) => message.report)
            .map((message) => message.id)
            .toSorted(),
          reports.map((message) => message.id).toSorted(),
        );
        const answered = yield* orchestrator.getThreadProjection(launcherId);
        assert.deepEqual(
          answered.messages.find((message) => message.id === "answer:other")?.reportAnswer,
          undefined,
        );

        // The agent closes the question without a new version; a later version asks again.
        const resolve = (key: string, id: string) =>
          orchestrator.dispatch({
            type: "report.resolve",
            commandId: CommandId.make(id),
            threadId: launcherId,
            key,
            outcome: "Fixed in abc123",
          });
        yield* resolve("issue:9", "resolve:other");
        yield* count(0);
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(launcherId)).messages.find(
            (message) => message.id === "report:other",
          )?.report?.resolved?.outcome,
          "Fixed in abc123",
        );
        for (const [key, cause] of [
          ["issue:9", 'Version 1 of report "issue:9" is already resolved.'],
          ["issue:404", 'No report has key "issue:404".'],
          ["pr:214", 'Version 3 of report "pr:214" is already dismissed.'],
        ] as const) {
          assert.include(String((yield* Effect.flip(resolve(key, `resolve:${key}`))).cause), cause);
        }
        // The agent closed it, so the person reopens and answers instead of dismissing.
        const dismissResolved = orchestrator.dispatch({
          type: "report.dismiss",
          commandId: CommandId.make("dismiss:other"),
          threadId: launcherId,
          messageId: MessageId.make("report:other"),
          key: "issue:9",
          version: 1,
        });
        assert.include(
          String((yield* Effect.flip(dismissResolved)).cause),
          'Version 1 of report "issue:9" is already resolved.',
        );
        yield* post("report:other:2", "issue:9");
        yield* count(1);
        yield* post("report:plain", "issue:10");
        yield* orchestrator.dispatch({
          type: "report.resolve",
          commandId: CommandId.make("resolve:plain"),
          threadId: launcherId,
          key: "issue:10",
        });
        yield* count(1);
        const plain = (yield* orchestrator.getThreadProjection(launcherId)).messages.find(
          (message) => message.id === "report:plain",
        )?.report?.resolved;
        assert.isDefined(plain?.at);
        assert.isUndefined(plain?.outcome);

        yield* endTurn(last, "completed");
      }),
    ),
);

const personThreadId = ThreadId.make("thread:report-person");

it.effect("a thread a person starts under a coordinator reports its first result once", () =>
  harness(
    "coordinator-person",
    ({ create, send, endTurn, reports }) =>
      Effect.gen(function* () {
        yield* create(personThreadId, undefined, { byPerson: true });
        const first = yield* send(personThreadId, "Fix the README", { sender: "user" });
        assert.include(first.message.text, launcherId, "the first turn names the coordinator");
        yield* endTurn(first, "completed");
        const delivered = yield* reports();
        assert.equal(delivered.length, 1);
        assert.include(delivered[0]?.text ?? "", "Thread in the project you coordinate");

        // The person is in the conversation now, so their follow-ups are theirs.
        const followUp = yield* send(personThreadId, "Also the CHANGELOG", { sender: "user" });
        yield* endTurn(followUp, "completed");
        assert.equal((yield* reports()).length, 1);
      }),
    { coordinator: true },
  ),
);

it.effect("a thread the coordinator launched with reportBack reports to it once", () =>
  harness(
    "coordinator-launched",
    ({ orchestrator, send, endTurn, reports }) =>
      Effect.gen(function* () {
        const launched = yield* orchestrator.getThreadProjection(launchedId);
        assert.deepEqual(launched.thread.reportTo, reportTo, "the launcher's own target is kept");
        const turn = yield* send(launchedId, "Fix the login page");
        yield* endTurn(turn, "completed");
        assert.equal((yield* reports()).length, 1);
      }),
    { coordinator: true },
  ),
);

it.effect("clearing the coordinator stops reports", () =>
  harness(
    "coordinator-cleared",
    ({ create, setCoordinator, send, endTurn, reports }) =>
      Effect.gen(function* () {
        yield* create(personThreadId, undefined, { byPerson: true });
        yield* setCoordinator(null);
        const turn = yield* send(personThreadId, "Fix the README", { sender: "user" });
        yield* endTurn(turn, "failed");
        assert.equal((yield* reports()).length, 0);
      }),
    { coordinator: true },
  ),
);

it.effect("a coordinator that reports to its launcher does not wake it in a cycle", () =>
  harness(
    "coordinator-cycle",
    ({ orchestrator, create, setCoordinator, send, endTurn, started }) =>
      Effect.gen(function* () {
        const oldCoordinator = ThreadId.make("thread:old-coordinator");
        const newCoordinator = ThreadId.make("thread:new-coordinator");
        yield* create(oldCoordinator, undefined, { byPerson: true });
        yield* setCoordinator(oldCoordinator);
        // The old coordinator launched this thread with reportBack, then the person promoted it.
        yield* create(newCoordinator, { threadId: oldCoordinator });
        yield* setCoordinator(newCoordinator);
        const turn = yield* send(newCoordinator, "Finish the work");
        const woken = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.threadId === oldCoordinator &&
              event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* endTurn(turn, "completed");
        yield* Fiber.join(woken);
        const oldWake = started.at(-1)!;
        assert.equal(oldWake.threadId, oldCoordinator, "the launcher hears the result");
        const before = started.length;
        yield* endTurn(oldWake, "completed");
        assert.equal(started.length, before, "answering a report does not wake the coordinator");
      }),
    { coordinator: true },
  ),
);

it.effect.each(["switched", "cleared"] as const)(
  "a blocked report is withdrawn where it was delivered after the coordinator is %s",
  (change) =>
    harness(
      `coordinator-withdraw-${change}`,
      ({ orchestrator, create, setCoordinator, send, askQuestion, reports, worker }) =>
        Effect.gen(function* () {
          yield* send(launcherId, "Coordinate the batch");
          yield* create(personThreadId, undefined, { byPerson: true });
          const turn = yield* send(personThreadId, "Ship it", { sender: "user" });
          yield* askQuestion(turn, "request:switched", "pending");
          yield* TestClock.adjust("2 minutes");
          yield* worker.drain();
          const [report] = yield* reports();
          assert.isDefined(report);
          if (change === "switched") {
            const replacement = ThreadId.make("thread:replacement");
            yield* create(replacement);
            yield* setCoordinator(replacement);
          } else {
            yield* setCoordinator(null);
          }
          yield* askQuestion(turn, "request:switched", "resolved");
          const previous = yield* orchestrator.getThreadProjection(launcherId);
          assert.equal(
            previous.runs.find((run) => run.userMessageId === report!.id)?.status,
            "cancelled",
          );
        }),
      { coordinator: true },
    ),
);

it.effect("another project's thread named as coordinator is never woken", () =>
  harness(
    "coordinator-cross-project",
    ({ orchestrator, create, setCoordinator, send, endTurn, started }) =>
      Effect.gen(function* () {
        const foreign = ThreadId.make("thread:foreign");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create:foreign"),
          threadId: foreign,
          projectId: ProjectId.make("project:other"),
          title: "Other project",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* setCoordinator(foreign);
        yield* create(personThreadId, undefined, { byPerson: true });
        const turn = yield* send(personThreadId, "Finish", { sender: "user" });
        yield* endTurn(turn, "completed");
        assert.isFalse(started.some((candidate) => candidate.threadId === foreign));
      }),
    { coordinator: true },
  ),
);

it.effect(
  "two blocked reports checked at once both withdraw after the coordinator is cleared",
  () =>
    harness(
      "coordinator-withdraw-two",
      ({ orchestrator, settings, create, setCoordinator, send, askQuestion, reports }) =>
        Effect.gen(function* () {
          yield* send(launcherId, "Coordinate the batch");
          yield* create(personThreadId, undefined, { byPerson: true });
          const turn = yield* send(personThreadId, "Ship it", { sender: "user" });
          yield* askQuestion(turn, "request:first", "pending");
          yield* askQuestion(turn, "request:second", "pending");

          // Both checks read the thread before either records where its report went.
          const threads = {
            dispatch: orchestrator.dispatch,
            getThreadRecords: orchestrator.getThreadRecords,
            getThreadShell: orchestrator.getThreadShell,
            reportRecipient: (thread: Parameters<typeof reportRecipient>[1]) =>
              reportRecipient(
                { settings: settings.getSettings, getThreadShell: orchestrator.getThreadShell },
                thread,
              ),
          };
          const reached = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const paused = {
            ...threads,
            dispatch: (command: Parameters<typeof orchestrator.dispatch>[0]) =>
              Deferred.succeed(reached, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(orchestrator.dispatch(command)),
              ),
          };
          const check = (deps: typeof threads, requestId: string) =>
            checkThreadReport(deps, {
              environmentId: undefined,
              threadId: personThreadId,
              trigger: { kind: "request", requestId: RuntimeRequestId.make(requestId) },
            });
          const first = yield* check(paused, "request:first").pipe(Effect.forkScoped);
          yield* Deferred.await(reached);
          yield* check(threads, "request:second");
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          const delivered = yield* reports();
          assert.equal(delivered.length, 2);

          yield* setCoordinator(null);
          yield* askQuestion(turn, "request:first", "resolved");
          yield* askQuestion(turn, "request:second", "resolved");
          const coordinator = yield* orchestrator.getThreadProjection(launcherId);
          for (const report of delivered) {
            assert.equal(
              coordinator.runs.find((run) => run.userMessageId === report.id)?.status,
              "cancelled",
            );
          }
        }),
      { coordinator: true },
    ),
);

it.effect("recording a sent report keeps a blocked report recorded after its read", () =>
  harness(
    "coordinator-sent-keeps-blocked",
    ({ orchestrator, create }) =>
      Effect.gen(function* () {
        yield* create(personThreadId, undefined, { byPerson: true });
        const record = (requestId: string) =>
          orchestrator.dispatch({
            type: "thread.report-target.blocked-report",
            commandId: CommandId.make(`record:${requestId}`),
            threadId: personThreadId,
            requestId: RuntimeRequestId.make(requestId),
            recipient: launcherId,
          });
        const targetNow = () =>
          orchestrator
            .getThreadProjection(personThreadId)
            .pipe(Effect.map((projection) => projection.thread.reportTo));
        yield* record("request:early");
        // An explicit report reads the target, then another blocked report lands before it saves.
        const read = (yield* targetNow())!;
        yield* record("request:late");
        yield* orchestrator.dispatch({
          type: "thread.report-target.set",
          commandId: CommandId.make("sent-report"),
          threadId: personThreadId,
          reportTo: { ...read, sentInRunId: RunId.make("run:sent") },
        });
        const saved = yield* targetNow();
        assert.equal(saved?.sentInRunId, "run:sent");
        assert.deepEqual(Object.keys(saved?.blockedReportsTo ?? {}).toSorted(), [
          "request:early",
          "request:late",
        ]);
      }),
    { coordinator: true },
  ),
);

it.effect("answers given outside the chat reach it on its next turn as one list, once", () =>
  harness(
    "coordinator-answer-notes",
    ({ orchestrator, send, endTurn, ask, worker, started }) =>
      Effect.gen(function* () {
        const chatTurn = yield* send(launcherId, "Coordinate the batch");
        yield* endTurn(chatTurn, "completed");
        const turn = yield* send(launchedId, "Fix the login page");
        yield* ask(turn, "request:db", "question");
        yield* ask(turn, "request:install", "approval");
        yield* ask(turn, "request:own", "question");
        yield* ask(turn, "request:server", "question");
        yield* ask(turn, "request:skip", "question", true);
        const respond = (
          requestId: string,
          answer: { readonly decision?: "accept" } | { readonly answers?: Record<string, string> },
          by?: { readonly createdBy: "user" | "agent"; readonly senderThreadId?: ThreadId },
        ) =>
          orchestrator.dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make(`respond:${requestId}`),
            threadId: launchedId,
            requestId: RuntimeRequestId.make(requestId),
            ...answer,
            ...by,
          });
        const chatTurns = () => started.filter((input) => input.threadId === launcherId).length;
        const before = chatTurns();
        yield* respond("request:db", { answers: { db: "Postgres" } }, { createdBy: "user" });
        yield* respond("request:install", { decision: "accept" }, { createdBy: "user" });
        // The chat's own answer, and one the server gives, name no one the chat has not heard.
        yield* respond(
          "request:own",
          { answers: { db: "SQLite" } },
          { createdBy: "agent", senderThreadId: launcherId },
        );
        yield* respond("request:server", { answers: { db: "MySQL" } });
        yield* orchestrator.dispatch({
          type: "thread.user-input.dismiss",
          commandId: CommandId.make("dismiss:skip"),
          threadId: launchedId,
          requestId: RuntimeRequestId.make("request:skip"),
          createdBy: "user",
        });
        yield* worker.drain();
        assert.equal(chatTurns(), before, "an answer does not wake the chat");

        const next = yield* send(launcherId, "What is left?");
        const text = next.message.text;
        const head = answerNotesText([]);
        assert.equal(text.split(head).length, 2, "one list");
        assert.include(
          text,
          `- "Fix the login page" (${launchedId}): the user answered the question "Which database?" with "Postgres".`,
        );
        assert.include(
          text,
          `- "Fix the login page" (${launchedId}): the user approved "Run vp i".`,
        );
        assert.include(
          text,
          `- "Fix the login page" (${launchedId}): the user dismissed the question "Which database?".`,
        );
        assert.notInclude(text, "SQLite");
        assert.notInclude(text, "MySQL");
        yield* endTurn(next, "completed");
        const notes = () =>
          orchestrator
            .getThreadProjection(launcherId)
            .pipe(Effect.map((projection) => projection.thread.answerNotes ?? []));
        assert.deepEqual(yield* notes(), [], "dropped once delivered");
        const again = yield* send(launcherId, "Anything else?");
        assert.notInclude(again.message.text, head, "delivered once");
        yield* endTurn(again, "completed");

        // A report answered, as clients send it, and another dismissed.
        const post = (key: string) =>
          orchestrator.dispatch({
            type: "report.post",
            commandId: CommandId.make(`report:${key}`),
            threadId: launchedId,
            messageId: MessageId.make(`report:${key}`),
            key,
            title:
              key === "merge"
                ? "Merge the fix?"
                : key === "ship"
                  ? "Ship it?"
                  : key === "notes"
                    ? "Merge the fix?, version 1] notes"
                    : "Old plan",
            body: "Ready.",
            ...(key === "plan" ? {} : { question: `${key}?` }),
          });
        yield* post("merge");
        yield* post("plan");
        yield* post("ship");
        yield* post("notes");
        yield* endTurn(turn, "completed");
        // A title holding another report's prefix: the longest match is the report it names.
        const nestedReply = yield* send(
          launchedId,
          "[Merge the fix?, version 1] notes, version 1] Which notes?",
          { sender: "user" },
        );
        assert.include(
          nestedReply.message.text,
          'about your report "Merge the fix?, version 1] notes" (version 1)',
        );
        yield* endTurn(nestedReply, "completed");
        // A typed reply names the report without answering it.
        const replyNote =
          'Note: this message is about your report "Merge the fix?" (version 1), whose question is still open.';
        const reply = yield* send(launchedId, "[Merge the fix?, version 1] Is it tested?", {
          sender: "user",
        });
        assert.include(reply.message.text, replyNote);
        yield* endTurn(reply, "completed");
        const answered = yield* send(launchedId, "[Merge the fix?, version 1] Merge it", {
          sender: "user",
          reportAnswer: { messageId: MessageId.make("report:merge"), key: "merge", version: 1 },
        });
        assert.include(
          answered.message.text,
          'Note: this message answers your report "Merge the fix?" (version 1), which closes its question.',
        );
        yield* endTurn(answered, "completed");
        const late = yield* send(launchedId, "[Merge the fix?, version 1] Thanks", {
          sender: "user",
        });
        assert.notInclude(late.message.text, replyNote);
        yield* endTurn(late, "completed");
        yield* orchestrator.dispatch({
          type: "report.dismiss",
          commandId: CommandId.make("dismiss:plan"),
          threadId: launchedId,
          messageId: MessageId.make("report:plan"),
          key: "plan",
          version: 1,
        });
        yield* orchestrator.dispatch({
          type: "report.resolve",
          commandId: CommandId.make("resolve:ship"),
          threadId: launchedId,
          key: "ship",
          outcome: "Shipped",
        });
        // The person's answer stands.
        assert.include(
          String(
            (yield* Effect.flip(
              orchestrator.dispatch({
                type: "report.resolve",
                commandId: CommandId.make("resolve:merge"),
                threadId: launchedId,
                key: "merge",
              }),
            )).cause,
          ),
          'Version 1 of report "merge" is already answered.',
        );
        // With an outcome it records what happened under the answer, and tells no one. A later
        // outcome replaces it.
        for (const outcome of ["Auto-merge on", "Merged as abc123"])
          yield* orchestrator.dispatch({
            type: "report.resolve",
            commandId: CommandId.make(`outcome:merge:${outcome}`),
            threadId: launchedId,
            key: "merge",
            outcome,
          });
        assert.deepInclude(
          (yield* orchestrator.getThreadProjection(launchedId)).messages.find(
            (message) => message.id === "report:merge",
          )?.report?.resolved,
          { outcome: "Merged as abc123" },
        );
        yield* worker.drain();
        assert.deepEqual(
          (yield* notes()).map((note) => note.text),
          [
            `- "Fix the login page" (${launchedId}): the user answered the report "Merge the fix?" with "Merge it".`,
            `- "Fix the login page" (${launchedId}): the user dismissed the report "Old plan".`,
            `- "Fix the login page" (${launchedId}): its agent resolved the report "Ship it?" as "Shipped".`,
          ],
        );

        // Kept for the next turn, at most the latest ten.
        for (let index = 0; index < 12; index++) {
          yield* orchestrator.dispatch({
            type: "thread.answer-notes.update",
            commandId: CommandId.make(`note:${index}`),
            threadId: launcherId,
            note: {
              id: `note:${index}`,
              text: `- note ${index}`,
              occurredAt: "2026-11-19T00:00:00.000Z",
            },
            delivered: [],
          });
        }
        const capped =
          (yield* orchestrator.getThreadProjection(launcherId)).thread.answerNotes ?? [];
        assert.deepEqual(
          capped.map((note) => note.id),
          Array.from({ length: 10 }, (_, index) => `note:${index + 2}`),
        );
      }),
    { coordinator: true },
  ),
);
