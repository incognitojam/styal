import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderStallMonitor from "./ProviderStallMonitor.ts";

const stores = Layer.mergeAll(ProjectionStore.layer, EventStore.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const foundation = EventSink.layer.pipe(Layer.provideMerge(stores));
const providerInstanceId = ProviderInstanceId.make("synthetic-private-provider");
const modelSelection = { instanceId: providerInstanceId, model: "synthetic-model" };
let eventSequence = 0;
const eventId = () => EventId.make(`stall-test:${++eventSequence}`);

const seed = Effect.fnUntraced(function* (options?: {
  attached?: boolean;
  starting?: boolean;
  suffix?: string;
}) {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const suffix = options?.suffix ?? "main";
  const threadId = ThreadId.make(`stall-thread:${suffix}`);
  const runId = RunId.make(`stall-run:${suffix}`);
  const rootNodeId = NodeId.make(`stall-root:${suffix}`);
  const attemptId = RunAttemptId.make(`stall-attempt:${suffix}`);
  const run: OrchestrationV2Run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: ProviderThreadId.make(`stall-provider-thread:${suffix}`),
    userMessageId: MessageId.make(`stall-message:${suffix}`),
    rootNodeId,
    activeAttemptId: attemptId,
    status: options?.starting ? "starting" : "running",
    requestedAt: now,
    startedAt: options?.starting ? null : now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const attempt: OrchestrationV2RunAttempt = {
    id: attemptId,
    runId,
    attemptOrdinal: 1,
    rootNodeId,
    providerInstanceId,
    providerThreadId: run.providerThreadId!,
    providerTurnId: options?.attached ? ProviderTurnId.make(`stall-provider-turn:${suffix}`) : null,
    reason: "initial",
    status: options?.starting ? "pending" : "running",
    startedAt: options?.starting ? null : now,
    completedAt: null,
  };
  yield* sink.write({
    events: [
      {
        id: eventId(),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          id: threadId,
          projectId: ProjectId.make("stall-project"),
          title: "Synthetic agent task",
          createdBy: "user",
          creationSource: "web",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      },
      {
        id: eventId(),
        type: "run.created",
        threadId,
        runId,
        occurredAt: now,
        payload: run,
      },
      {
        id: eventId(),
        type: "run-attempt.created",
        threadId,
        runId,
        occurredAt: now,
        payload: attempt,
      },
    ],
  });
  return { run, attempt };
});

const writeItem = Effect.fnUntraced(function* (
  owner: Effect.Success<ReturnType<typeof seed>>,
  type: "reasoning" | "command_execution" | "system_notice" = "reasoning",
  status: "completed" | "running" = "completed",
) {
  const now = yield* DateTime.now;
  const { run, attempt } = owner;
  const base = {
    id: TurnItemId.make(`stall-item:${run.id}:${type}`),
    threadId: run.threadId,
    runId: run.id,
    nodeId: run.rootNodeId,
    providerThreadId: run.providerThreadId,
    providerTurnId: attempt.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status,
    title: null,
    startedAt: now,
    completedAt: status === "completed" ? now : null,
    updatedAt: now,
  };
  const item: OrchestrationV2TurnItem =
    type === "command_execution"
      ? { ...base, type, input: "synthetic-command" }
      : type === "system_notice"
        ? { ...base, type, message: "An unrelated notice" }
        : { ...base, type, text: "Synthetic progress", streaming: status === "running" };
  yield* (yield* EventSink.EventSinkV2).write({
    events: [
      {
        id: eventId(),
        type: "turn-item.updated",
        threadId: run.threadId,
        runId: run.id,
        occurredAt: now,
        payload: item,
      },
    ],
  });
  return item;
});

const withHarness = <A, E>(
  test: (
    events: Array<{ name: string; properties: Readonly<Record<string, unknown>> | undefined }>,
  ) => Effect.Effect<
    A,
    E,
    | ProviderStallMonitor.ProviderStallMonitor
    | ProjectionStore.ProjectionStoreV2
    | EventSink.EventSinkV2
  >,
) =>
  Effect.suspend(() => {
    const events: Array<{
      name: string;
      properties: Readonly<Record<string, unknown>> | undefined;
    }> = [];
    const layer = ProviderStallMonitor.layer.pipe(
      Layer.provideMerge(foundation),
      Layer.provide(IdAllocator.layer),
      Layer.provide(
        Layer.succeed(AnalyticsService.AnalyticsService, {
          recordOwners: () => Effect.void,
          record: (name, properties) =>
            Effect.sync(() => {
              events.push({ name, properties });
            }),
          flush: Effect.void,
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: () => Effect.succeed(undefined),
        }),
      ),
    );
    return test(events).pipe(Effect.provide(layer));
  });

it.effect("records one startup incident and resolves it on activity without changing the run", () =>
  withHarness((events) =>
    Effect.gen(function* () {
      const owner = yield* seed();
      const monitor = yield* ProviderStallMonitor.ProviderStallMonitor;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      assert.lengthOf(yield* projections.getProviderStallCandidates(), 1);
      yield* TestClock.adjust("4 minutes");
      yield* monitor.sweep;
      assert.lengthOf(yield* projections.getOpenProviderStalls(), 0);
      yield* TestClock.adjust("1 minute");
      yield* monitor.sweep;
      yield* monitor.sweep;
      const [notice] = yield* projections.getOpenProviderStalls();
      assert.equal(notice?.providerStall?.phase, "startup");
      assert.lengthOf(events, 1);
      yield* writeItem(owner);
      yield* monitor.sweep;
      yield* monitor.sweep;
      assert.lengthOf(yield* projections.getOpenProviderStalls(), 0);
      const retained = yield* projections.getTurnItem({
        threadId: owner.run.threadId,
        itemId: notice!.id,
      });
      assert.isTrue(
        retained?.type === "system_notice" && retained.providerStall?.resolution === "activity",
      );
      assert.equal((yield* projections.getProviderStallCandidates())[0]?.run.status, "running");
      assert.deepEqual(
        events.map((event) => event.properties?.outcome),
        ["detected", "activity"],
      );
      assert.notInclude(JSON.stringify(events), providerInstanceId);
      assert.notInclude(JSON.stringify(events), owner.run.id);
    }),
  ),
);

it.effect("detects silent streamed reasoning but suppresses running tools", () =>
  withHarness(() =>
    Effect.gen(function* () {
      const owner = yield* seed({ attached: true });
      yield* writeItem(owner, "reasoning", "running");
      const monitor = yield* ProviderStallMonitor.ProviderStallMonitor;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* TestClock.adjust("9 minutes");
      yield* monitor.sweep;
      assert.lengthOf(yield* projections.getOpenProviderStalls(), 0);
      yield* TestClock.adjust("1 minute");
      yield* monitor.sweep;
      assert.equal(
        (yield* projections.getOpenProviderStalls())[0]?.providerStall?.phase,
        "provider_silent",
      );
      yield* writeItem(owner, "command_execution", "running");
      yield* monitor.sweep;
      yield* TestClock.adjust("1 hour");
      yield* monitor.sweep;
      assert.lengthOf(yield* projections.getOpenProviderStalls(), 0);
    }),
  ),
);

it.effect("finds attachment through the provider turn even when the attempt linkage is null", () =>
  withHarness(() =>
    Effect.gen(function* () {
      const owner = yield* seed();
      const monitor = yield* ProviderStallMonitor.ProviderStallMonitor;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      yield* TestClock.adjust("5 minutes");
      yield* monitor.sweep;
      assert.lengthOf(yield* projections.getOpenProviderStalls(), 1);
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: eventId(),
            type: "provider-turn.updated",
            threadId: owner.run.threadId,
            runId: owner.run.id,
            occurredAt: now,
            payload: {
              id: ProviderTurnId.make("native-attachment"),
              providerThreadId: owner.attempt.providerThreadId,
              nodeId: owner.attempt.rootNodeId,
              runAttemptId: owner.attempt.id,
              nativeTurnRef: null,
              ordinal: 1,
              status: "running",
              startedAt: now,
              completedAt: null,
            },
          },
        ],
      });
      yield* monitor.sweep;
      assert.lengthOf(yield* projections.getOpenProviderStalls(), 0);
      yield* TestClock.adjust("9 minutes");
      yield* monitor.sweep;
      assert.lengthOf(yield* projections.getOpenProviderStalls(), 0);
      yield* TestClock.adjust("1 minute");
      yield* monitor.sweep;
      assert.equal(
        (yield* projections.getOpenProviderStalls())[0]?.providerStall?.phase,
        "provider_silent",
      );
    }),
  ),
);

it.effect(
  "suppresses session-scoped questions and retry backoff without treating them as crashes",
  () =>
    withHarness(() =>
      Effect.gen(function* () {
        const owner = yield* seed();
        const sink = yield* EventSink.EventSinkV2;
        const monitor = yield* ProviderStallMonitor.ProviderStallMonitor;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const request = {
          id: RuntimeRequestId.make("startup-question"),
          nodeId: NodeId.make("startup-request-node"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input" as const,
          status: "pending" as const,
          responseCapability: { type: "server" as const },
          createdAt: now,
          resolvedAt: null,
        };
        yield* sink.write({
          events: [
            {
              id: eventId(),
              type: "runtime-request.updated",
              threadId: owner.run.threadId,
              occurredAt: now,
              payload: request,
            },
          ],
        });
        yield* TestClock.adjust("1 hour");
        yield* monitor.sweep;
        assert.lengthOf(yield* projections.getOpenProviderStalls(), 0);
        const later = yield* DateTime.now;
        const base = yield* writeItem(owner);
        yield* sink.write({
          events: [
            {
              id: eventId(),
              type: "runtime-request.updated",
              threadId: owner.run.threadId,
              occurredAt: later,
              payload: { ...request, status: "resolved", resolvedAt: later },
            },
            {
              id: eventId(),
              type: "turn-item.updated",
              threadId: owner.run.threadId,
              runId: owner.run.id,
              occurredAt: later,
              payload: {
                ...base,
                type: "error",
                status: "running",
                retry: { attempt: 1, maxAttempts: 3, retryDelayMs: 60_000 },
                failure: {
                  class: "provider_error",
                  message: "Synthetic retry",
                  code: null,
                  retryable: true,
                },
              },
            },
          ],
        });
        yield* TestClock.adjust("15 minutes");
        yield* monitor.sweep;
        assert.lengthOf(yield* projections.getOpenProviderStalls(), 0);
      }),
    ),
);

it.effect("does not charge queued time against startup", () =>
  withHarness(() =>
    Effect.gen(function* () {
      const owner = yield* seed({ starting: true });
      const sink = yield* EventSink.EventSinkV2;
      const monitor = yield* ProviderStallMonitor.ProviderStallMonitor;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const initial = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: eventId(),
            type: "run.updated",
            threadId: owner.run.threadId,
            runId: owner.run.id,
            occurredAt: initial,
            payload: { ...owner.run, status: "queued" },
          },
        ],
      });
      yield* TestClock.adjust("1 hour");
      yield* monitor.sweep;
      assert.lengthOf(yield* projections.getOpenProviderStalls(), 0);
      const starting = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: eventId(),
            type: "run.updated",
            threadId: owner.run.threadId,
            runId: owner.run.id,
            occurredAt: starting,
            payload: owner.run,
          },
        ],
      });
      yield* monitor.sweep;
      assert.lengthOf(yield* projections.getOpenProviderStalls(), 0);
      yield* TestClock.adjust("5 minutes");
      yield* monitor.sweep;
      assert.lengthOf(yield* projections.getOpenProviderStalls(), 1);
    }),
  ),
);

it.effect("includes startup before attempt attachment and clears a warning when the run ends", () =>
  withHarness((events) =>
    Effect.gen(function* () {
      const owner = yield* seed({ starting: true });
      const monitor = yield* ProviderStallMonitor.ProviderStallMonitor;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* TestClock.adjust("5 minutes");
      yield* monitor.sweep;
      assert.lengthOf(yield* projections.getOpenProviderStalls(), 1);
      const now = yield* DateTime.now;
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            id: eventId(),
            type: "run.updated",
            threadId: owner.run.threadId,
            runId: owner.run.id,
            occurredAt: now,
            payload: { ...owner.run, status: "interrupted", completedAt: now },
          },
        ],
      });
      yield* monitor.sweep;
      assert.lengthOf(yield* projections.getOpenProviderStalls(), 0);
      assert.deepEqual(
        events.map((event) => event.properties?.outcome),
        ["detected", "run_ended"],
      );
    }),
  ),
);

it.effect("starts a fresh inactivity budget after a session-scoped question is answered", () =>
  withHarness(() =>
    Effect.gen(function* () {
      const owner = yield* seed();
      const sink = yield* EventSink.EventSinkV2;
      const monitor = yield* ProviderStallMonitor.ProviderStallMonitor;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* TestClock.adjust("5 minutes");
      yield* monitor.sweep;
      const previous = (yield* projections.getOpenProviderStalls())[0]!;
      const askedAt = yield* DateTime.now;
      const request = {
        id: RuntimeRequestId.make("late-startup-question"),
        nodeId: NodeId.make("session-startup-node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input" as const,
        status: "pending" as const,
        responseCapability: { type: "server" as const },
        createdAt: askedAt,
        resolvedAt: null,
      };
      yield* sink.write({
        events: [
          {
            id: eventId(),
            type: "runtime-request.updated",
            threadId: owner.run.threadId,
            occurredAt: askedAt,
            payload: request,
          },
        ],
      });
      yield* monitor.sweep;
      assert.lengthOf(yield* projections.getOpenProviderStalls(), 0);
      yield* TestClock.adjust("1 hour");
      const answeredAt = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: eventId(),
            type: "runtime-request.updated",
            threadId: owner.run.threadId,
            occurredAt: answeredAt,
            payload: { ...request, status: "resolved", resolvedAt: answeredAt },
          },
        ],
      });
      yield* monitor.sweep;
      assert.lengthOf(yield* projections.getOpenProviderStalls(), 0);
      yield* TestClock.adjust("5 minutes");
      yield* monitor.sweep;
      const next = (yield* projections.getOpenProviderStalls())[0]!;
      assert.isDefined(next);
      assert.notEqual(next.id, previous.id);
      assert.equal(next.providerStall?.lastActivityAt, DateTime.toEpochMillis(answeredAt));
    }),
  ),
);

it.effect(
  "counts assistant message progress when a provider emits no matching turn-item update",
  () =>
    withHarness(() =>
      Effect.gen(function* () {
        const owner = yield* seed({ attached: true });
        yield* TestClock.adjust("9 minutes");
        const now = yield* DateTime.now;
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            {
              id: eventId(),
              type: "message.updated",
              threadId: owner.run.threadId,
              runId: owner.run.id,
              occurredAt: now,
              payload: {
                id: MessageId.make("streamed-assistant"),
                threadId: owner.run.threadId,
                runId: owner.run.id,
                nodeId: owner.run.rootNodeId,
                createdBy: "agent",
                creationSource: "provider",
                role: "assistant",
                text: "Synthetic streamed output",
                attachments: [],
                streaming: true,
                createdAt: now,
                updatedAt: now,
              },
            },
          ],
        });
        yield* TestClock.adjust("1 minute");
        yield* (yield* ProviderStallMonitor.ProviderStallMonitor).sweep;
        assert.lengthOf(
          yield* (yield* ProjectionStore.ProjectionStoreV2).getOpenProviderStalls(),
          0,
        );
      }),
    ),
);

it.effect("ignores sibling activity and diagnostic notices", () =>
  withHarness(() =>
    Effect.gen(function* () {
      const owner = yield* seed();
      const sibling = yield* seed({ suffix: "sibling" });
      yield* TestClock.adjust("5 minutes");
      yield* writeItem(sibling);
      yield* writeItem(owner, "system_notice");
      yield* (yield* ProviderStallMonitor.ProviderStallMonitor).sweep;
      const open = yield* (yield* ProjectionStore.ProjectionStoreV2).getOpenProviderStalls();
      assert.deepEqual(
        open.map((item) => item.runId),
        [owner.run.id],
      );
    }),
  ),
);

it.effect("refuses a detection write when activity races the observation", () =>
  withHarness(() =>
    Effect.gen(function* () {
      const owner = yield* seed();
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const before = (yield* projections.getProviderStallCandidates())[0]!;
      yield* TestClock.adjust("5 minutes");
      yield* writeItem(owner);
      const result = yield* (yield* EventSink.EventSinkV2).writeIfRunCurrent({
        threadId: owner.run.threadId,
        runId: owner.run.id,
        activeAttemptId: owner.attempt.id,
        expectedStatus: "running",
        providerStallGuard: { phase: before.phase, lastActivityAt: before.lastActivityAt },
        events: [],
      });
      assert.isFalse(result.committed);
    }),
  ),
);
