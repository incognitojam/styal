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
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
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
}) => {
  const { name, cwd, events, started } = input;
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const create = (threadId: ThreadId, target?: OrchestrationV2ThreadReportTarget) =>
      orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make(`project:${name}`),
        title: threadId === launchedId ? "Fix the login page" : "Coordinator",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        createdBy: "agent",
        creationSource: "mcp",
        ...(target === undefined ? {} : { reportTo: target }),
      });
    yield* create(launcherId);
    yield* create(launchedId, reportTo);

    const send = (
      threadId: ThreadId,
      text: string,
      options?: { readonly sender?: "user" | "agent" },
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
            responseCapability: {
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

    return { orchestrator, worker, started, send, endTurn, askQuestion, reports };
  });
};
type ReportHarness = Effect.Success<ReturnType<typeof makeHelpers>>;

const harness = <A, E>(
  name: string,
  test: (helpers: ReportHarness) => Effect.Effect<A, E, Scope.Scope>,
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
      return yield* makeHelpers({ name, cwd, events, started }).pipe(
        Effect.flatMap(test),
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false, coordinatorReportsEnabled: true },
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
          reportAnswer,
        );

        yield* endTurn(last, "completed");
      }),
    ),
);
