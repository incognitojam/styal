// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import { OrchestrationV2ThreadProjectionJson, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Maintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import { layerMemory } from "../persistence/Sqlite.ts";
import { materializeV2ForkHistory } from "./V2ForkHistoryImport.ts";
import { makeV2HistoryWriter, readV2SourceProjection } from "./V2HistoryImport.ts";

const encodeProjection = Schema.encodeEffect(OrchestrationV2ThreadProjectionJson);
const decodeProjection = Schema.decodeUnknownEffect(OrchestrationV2ThreadProjectionJson);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const at = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("synthetic-v2-import");
const model = { instanceId: "codex", model: "recorded-model" };
const source = Schema.decodeUnknownSync(OrchestrationV2ThreadProjectionJson)({
  thread: {
    id: threadId,
    projectId: "source-project",
    title: "Synthetic native history",
    providerInstanceId: "codex",
    modelSelection: model,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: "native-thread",
    historyOrigin: "native",
    createdBy: "user",
    creationSource: "web",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    deletedAt: null,
  },
  runs: [
    {
      id: "run",
      threadId,
      ordinal: 1,
      providerInstanceId: "codex",
      modelSelection: model,
      providerThreadId: "native-thread",
      userMessageId: "message",
      rootNodeId: "node",
      activeAttemptId: null,
      status: "running",
      requestedAt: at,
      startedAt: at,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    },
  ],
  attempts: [],
  nodes: [
    {
      id: "node",
      threadId,
      runId: "run",
      parentNodeId: null,
      rootNodeId: "node",
      kind: "root_turn",
      status: "running",
      countsForRun: true,
      providerThreadId: "native-thread",
      providerTurnId: "native-turn",
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: at,
      completedAt: null,
    },
  ],
  subagents: [],
  providerSessions: [],
  providerThreads: [
    {
      id: "native-thread",
      driver: "codex",
      providerInstanceId: "codex",
      providerSessionId: "process-owned-session",
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: {
        nativeId: "resume-native",
        strength: "strong",
        refKind: "thread",
        driver: "codex",
        providerInstanceId: "codex",
      },
      nativeConversationHeadRef: null,
      status: "active",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: at,
      updatedAt: at,
    },
  ],
  providerTurns: [
    {
      id: "native-turn",
      providerThreadId: "native-thread",
      nodeId: "node",
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running",
      startedAt: at,
      completedAt: null,
      turnTokenUsage: {
        usageScope: "main_agent",
        usageStatus: "partial",
        hasSubagents: false,
        inputTokens: 800,
        outputTokens: 50,
        costUsd: 12.345,
      },
    },
  ],
  runtimeRequests: [],
  messages: [
    {
      id: "message",
      threadId,
      runId: "run",
      nodeId: null,
      role: "assistant",
      text: "Recorded answer",
      attachments: [],
      streaming: true,
      createdBy: "agent",
      creationSource: "provider",
      createdAt: at,
      updatedAt: at,
    },
  ],
  plans: [],
  turnItems: [
    {
      id: "tool-item",
      threadId,
      runId: "run",
      nodeId: "node",
      providerThreadId: "native-thread",
      providerTurnId: "native-turn",
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: "Recorded tool",
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      type: "dynamic_tool",
      toolName: "synthetic_tool",
      input: { synthetic: true },
      output: { recorded: "output" },
    },
  ],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: at,
});
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(layerMemory),
);
const layer = Layer.mergeAll(EventSink.layer, Maintenance.layer).pipe(Layer.provideMerge(stores));
it.layer(layer)("V2 source history import", (it) => {
  it.effect(
    "reads all canonical records, retains costs and tools, and never revives live work",
    () =>
      Effect.gen(function* () {
        const encoded = yield* encodeProjection(source);
        const db = new NodeSqlite.DatabaseSync(":memory:");
        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()));
        const fields = {
          threads: [encoded.thread],
          runs: encoded.runs,
          run_attempts: encoded.attempts,
          nodes: encoded.nodes,
          provider_threads: encoded.providerThreads,
          provider_turns: encoded.providerTurns,
          messages: encoded.messages,
          turn_items: encoded.turnItems,
        };
        for (const [suffix, records] of Object.entries(fields)) {
          db.exec(
            `CREATE TABLE orchestration_v2_projection_${suffix} (thread_id TEXT, payload_json TEXT)`,
          );
          for (const record of records)
            db.prepare(`INSERT INTO orchestration_v2_projection_${suffix} VALUES (?, ?)`).run(
              threadId,
              yield* encodeJson(record),
            );
        }
        const snapshot = yield* Effect.try(() =>
          readV2SourceProjection(
            {
              exec: (sql) => db.exec(sql),
              all: (sql, params = []) => db.prepare(sql).all(...params),
              close: () => {},
            },
            threadId,
          ),
        );
        const write = yield* makeV2HistoryWriter;
        yield* write(snapshot, ProjectId.make("target-project"));
        const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
          threadId,
        );
        assert.equal(projection.thread.projectId, "target-project");
        assert.equal(projection.runs[0]?.status, "cancelled");
        assert.equal(projection.providerThreads[0]?.providerSessionId, null);
        assert.equal(projection.providerThreads[0]?.status, "not_loaded");
        assert.equal(projection.providerThreads[0]?.nativeThreadRef?.nativeId, "resume-native");
        assert.equal(projection.providerTurns[0]?.turnTokenUsage?.costUsd, 12.345);
        assert.equal(projection.messages[0]?.text, "Recorded answer");
        assert.equal(projection.messages[0]?.streaming, false);
        assert.deepEqual(projection.turnItems[0], { ...source.turnItems[0]!, ordinal: 1000001 });
        assert.deepEqual(projection.providerSessions, []);
        const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
        yield* maintenance.compactEventStore;
        const rebuilt = yield* maintenance.rebuild;
        assert.deepEqual(rebuilt.valid ? true : rebuilt, true);
        yield* write(snapshot, ProjectId.make("target-project"));
        assert.deepEqual(
          yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(threadId),
          projection,
        );
      }),
  );
});
it.layer(layer)("V2 fork history import", (it) => {
  it.effect("materializes excluded or deleted fork ancestors without resurrecting them", () =>
    Effect.gen(function* () {
      const childId = ThreadId.make("synthetic-fork-child");
      const child = {
        ...source,
        thread: {
          ...source.thread,
          id: childId,
          lineage: {
            parentThreadId: source.thread.id,
            relationshipToParent: "fork" as const,
            rootThreadId: source.thread.id,
          },
          forkedFrom: {
            type: "run" as const,
            threadId: source.thread.id,
            runId: source.runs[0]!.id,
          },
          activeProviderThreadId: null,
        },
        nodes: [],
        providerThreads: [],
        providerTurns: [],
        messages: [],
        runs: [],
        attempts: [],
        turnItems: [],
      };
      const encodedParentBase = yield* encodeProjection(source);
      const parent = yield* decodeProjection({
        ...encodedParentBase,
        thread: {
          ...encodedParentBase.thread,
          deletedAt: at,
        },
        runs: [
          ...encodedParentBase.runs,
          {
            ...encodedParentBase.runs[0],
            id: "later-run",
            ordinal: 2,
          },
        ],
        turnItems: [
          ...encodedParentBase.turnItems,
          {
            ...encodedParentBase.turnItems[0],
            id: "answer-item",
            type: "assistant_message",
            messageId: "message",
            ordinal: 2,
            text: "Recorded answer",
            streaming: false,
          },
          {
            ...encodedParentBase.turnItems[0],
            id: "checkpoint-item",
            type: "checkpoint",
            checkpointId: "checkpoint",
            scopeId: "scope",
            files: [],
            ordinal: 3,
          },
          {
            ...encodedParentBase.turnItems[0],
            id: "plan-item",
            type: "proposed_plan",
            planId: "historical-plan",
            markdown: "Historical plan",
            streaming: false,
            ordinal: 4,
          },
          {
            ...encodedParentBase.turnItems[0],
            id: "later-item",
            runId: "later-run",
            ordinal: 3,
            title: "Excluded later tool",
          },
        ],
        plans: [
          {
            id: "historical-plan",
            threadId,
            runId: "run",
            nodeId: "node",
            status: "completed",
            kind: "proposed_plan",
            markdown: "Historical plan",
          },
        ],
        checkpointScopes: [
          {
            id: "scope",
            threadId,
            runId: "run",
            nodeId: "node",
            parentScopeId: null,
            providerThreadId: "native-thread",
            kind: "root_run",
            ordinalWithinParent: 0,
            advancesAppRunCount: true,
            cwd: "/synthetic/project",
            createdAt: at,
          },
        ],
        checkpoints: [
          {
            id: "checkpoint",
            threadId,
            scopeId: "scope",
            runId: "run",
            nodeId: "node",
            parentCheckpointId: null,
            ordinalWithinScope: 1,
            appRunOrdinal: 1,
            ref: "refs/synthetic/checkpoint",
            status: "ready",
            files: [],
            capturedAt: at,
            assistantMessageId: "message",
          },
        ],
      });
      const excluded = materializeV2ForkHistory(child, new Set(), () => parent);
      assert.equal(excluded.turnItems.length, 5);
      assert.equal(excluded.turnItems[0]?.type, "dynamic_tool");
      assert.equal(excluded.turnItems[0]?.runId, null);
      assert.equal(excluded.legacyTurnUsage?.records[0]?.usage?.costUsd, 12.345);
      assert.equal(excluded.legacyTurnUsage?.thread.costUsd, 12.345);
      assert.equal(excluded.thread.forkedFrom?.type, "run");
      assert.equal(
        materializeV2ForkHistory(child, new Set([source.thread.id]), () => {
          throw new Error("Included ancestors must remain live lineage references.");
        }),
        child,
      );
      const write = yield* makeV2HistoryWriter;
      yield* write(excluded, ProjectId.make("fork-project"));
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const projection = yield* store.getThreadProjection(childId);
      assert.deepEqual(
        projection.turnItems.find((item) => item.type === "dynamic_tool")?.type,
        "dynamic_tool",
      );
      assert.equal(projection.visibleTurnItems.length, 5);
      assert.equal(projection.messages[0]?.text, "Recorded answer");
      assert.equal(projection.messages[0]?.streaming, false);
      assert.equal(projection.checkpoints[0]?.ref, "refs/synthetic/checkpoint");
      assert.equal(projection.checkpoints[0]?.assistantMessageId, projection.messages[0]?.id);
      assert.equal(projection.checkpointScopes[0]?.kind, "manual");
      const checkpointItem = projection.turnItems.find((item) => item.type === "checkpoint");
      assert.equal(
        checkpointItem?.type === "checkpoint" ? checkpointItem.checkpointId : null,
        projection.checkpoints[0]?.id,
      );
      const planItem = projection.turnItems.find((item) => item.type === "proposed_plan");
      assert.equal(
        planItem?.type === "proposed_plan" ? planItem.planId : null,
        projection.plans[0]?.id,
      );
      assert.equal(
        projection.plans[0]?.kind === "proposed_plan" ? projection.plans[0].markdown : null,
        "Historical plan",
      );
      assert.isFalse(projection.turnItems.some((item) => item.title === "Excluded later tool"));
      assert.equal(
        (yield* store.getThreadSnapshotWindow(childId, { rowLimit: 10 })).projection
          .visibleTurnItems.length,
        5,
      );
      assert.equal(
        (yield* Effect.exit(store.getThreadProjection(source.thread.id)))._tag,
        "Failure",
      );
      const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
      yield* maintenance.compactEventStore;
      const rebuilt = yield* maintenance.rebuild;
      assert.deepEqual(yield* store.getThreadProjection(childId), projection);
      assert.isTrue(rebuilt.valid);
      yield* write(parent, ProjectId.make("fork-project"));
      assert.equal((yield* store.getThreadProjection(childId)).visibleTurnItems.length, 5);
      assert.equal(
        (yield* store.getThreadSnapshotWindow(childId, { rowLimit: 10 })).projection
          .visibleTurnItems.length,
        5,
      );
    }),
  );
});
