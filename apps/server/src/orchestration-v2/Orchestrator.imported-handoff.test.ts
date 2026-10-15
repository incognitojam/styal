import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderThreadId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { CLAUDE_MODEL_SELECTION, CODEX_MODEL_SELECTION } from "./testkit/fixtures/shared.ts";

const registry = ProviderAdapterRegistry.makeLayer(
  [CLAUDE_MODEL_SELECTION, CODEX_MODEL_SELECTION].map((selection) => ({
    instanceId: selection.instanceId,
    driver: ProviderDriverKind.make(selection.instanceId),
    getCapabilities: () =>
      Effect.succeed(
        selection.instanceId === "codex"
          ? CodexProviderCapabilitiesV2
          : ClaudeProviderCapabilitiesV2,
      ),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("Provider execution is paused for dispatch inspection"),
  })),
);
const layer = makeOrchestratorV2ReplayLayerWithRegistry({ name: "imported-handoff" }, registry, {
  runEffectWorker: false,
});
const testLayer = Layer.merge(
  layer,
  ProjectionMaintenance.layer.pipe(
    Layer.provide(
      Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
      ),
    ),
  ),
);

it.effect.each([
  { nativeSource: false, importedHistory: true, switchProvider: true, setSelectionFirst: false },
  { nativeSource: true, importedHistory: true, switchProvider: true, setSelectionFirst: false },
  { nativeSource: false, importedHistory: true, switchProvider: false, setSelectionFirst: false },
  { nativeSource: false, importedHistory: false, switchProvider: true, setSelectionFirst: false },
  { nativeSource: true, importedHistory: true, switchProvider: true, setSelectionFirst: true },
  { nativeSource: false, importedHistory: true, switchProvider: true, setSelectionFirst: true },
])(
  "records imported context at first dispatch: native=$nativeSource, history=$importedHistory, switch=$switchProvider, preset=$setSelectionFirst",
  ({ nativeSource, importedHistory, switchProvider, setSelectionFirst }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("imported-handoff-thread");
      const sourceProviderThreadId = ProviderThreadId.make("imported-claude-conversation");
      const target = switchProvider ? CODEX_MODEL_SELECTION : CLAUDE_MODEL_SELECTION;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-imported-handoff"),
        threadId,
        projectId: ProjectId.make("imported-handoff-project"),
        title: "Imported handoff",
        modelSelection: CLAUDE_MODEL_SELECTION,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const created = yield* orchestrator.getThreadProjection(threadId);
      yield* sink.write({
        events: [
          {
            id: EventId.make("imported-thread"),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: now,
            payload: {
              ...created.thread,
              historyOrigin: "v1_import",
              activeProviderThreadId: nativeSource ? sourceProviderThreadId : null,
            },
          },
          ...(nativeSource
            ? [
                {
                  id: EventId.make("imported-provider-thread"),
                  type: "provider-thread.updated" as const,
                  threadId,
                  occurredAt: now,
                  payload: {
                    id: sourceProviderThreadId,
                    driver: ProviderDriverKind.make("claudeAgent"),
                    providerInstanceId: CLAUDE_MODEL_SELECTION.instanceId,
                    providerSessionId: null,
                    appThreadId: threadId,
                    ownerNodeId: null,
                    nativeThreadRef: {
                      driver: ProviderDriverKind.make("claudeAgent"),
                      nativeId: "imported-native-conversation",
                      strength: "strong" as const,
                    },
                    nativeConversationHeadRef: null,
                    status: "not_loaded" as const,
                    firstRunOrdinal: null,
                    lastRunOrdinal: null,
                    handoffIds: [],
                    forkedFrom: null,
                    createdAt: now,
                    updatedAt: now,
                  },
                },
              ]
            : []),
          ...(importedHistory
            ? [
                {
                  id: EventId.make("imported-user-message"),
                  type: "turn-item.updated" as const,
                  threadId,
                  occurredAt: now,
                  payload: {
                    id: TurnItemId.make("imported-user-message"),
                    threadId,
                    runId: null,
                    nodeId: null,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 1000,
                    status: "completed" as const,
                    title: null,
                    startedAt: now,
                    completedAt: now,
                    updatedAt: now,
                    type: "user_message" as const,
                    createdBy: "user" as const,
                    creationSource: "server" as const,
                    inputIntent: "turn_start" as const,
                    messageId: MessageId.make("imported-user-message"),
                    text: "Remember that the release marker is violet.",
                    attachments: [],
                  },
                },
              ]
            : []),
        ],
      });
      if (setSelectionFirst) {
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make("select-imported-handoff-target"),
          threadId,
          modelSelection: target,
        });
      }
      const dispatch = {
        type: "message.dispatch" as const,
        commandId: CommandId.make("send-imported-handoff"),
        threadId,
        messageId: MessageId.make("send-imported-handoff"),
        createdBy: "user" as const,
        creationSource: "web" as const,
        modelSelection: target,
        text: "What was the release marker?",
        attachments: [],
        dispatchMode: { type: "start_immediately" as const },
      };
      yield* orchestrator.dispatch(dispatch);
      // Replaying the same send must not duplicate the notice.
      yield* orchestrator.dispatch(dispatch);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const notices = projection.turnItems.filter((item) => item.type === "handoff");
      assert.lengthOf(notices, importedHistory ? 1 : 0);
      if (!importedHistory) return;
      const notice = notices[0]!;
      const run = projection.runs[0]!;
      const handoff = projection.contextHandoffs.find((item) => item.id === run.contextHandoffId)!;
      assert.equal(notice.contextHandoffId, handoff.id);
      assert.equal(notice.runId, run.id);
      assert.equal(notice.title, "Imported context");
      assert.equal(notice.strategy, "manual_context");
      assert.equal(notice.toProviderInstanceId, target.instanceId);
      assert.equal(notice.toModel, target.model);
      assert.deepEqual(
        notice.fromModelSelections,
        switchProvider && !setSelectionFirst ? [CLAUDE_MODEL_SELECTION] : [],
      );
      assert.deepEqual(
        notice.fromProviderInstanceIds,
        nativeSource || (switchProvider && !setSelectionFirst)
          ? [CLAUDE_MODEL_SELECTION.instanceId]
          : [],
      );
      const importedItem = projection.turnItems.find(
        (item) => item.id === "imported-user-message",
      )!;
      const receivingPrompt = projection.turnItems.find(
        (item) => item.type === "user_message" && item.messageId === dispatch.messageId,
      )!;
      assert.isAbove(notice.ordinal, importedItem.ordinal);
      assert.isBelow(notice.ordinal, receivingPrompt.ordinal);
      assert.include(handoff.history!.messages[0]!.text, "release marker is violet");
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      yield* maintenance.rebuild;
      const rebuilt = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        rebuilt.turnItems.filter((item) => item.type === "handoff"),
        notices,
      );
      assert.equal(rebuilt.runs[0]?.contextHandoffId, handoff.id);
    }).pipe(Effect.provide(testLayer)),
);
