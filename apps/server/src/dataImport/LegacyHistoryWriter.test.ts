import { assert, it } from "@effect/vitest";
import {
  EventId,
  IsoDateTime,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { OrchestrationEvent } from "@t3tools/contracts/legacy-orchestration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import { makeLegacyHistoryWriter } from "./LegacyHistoryWriter.ts";

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const testLayer = Layer.mergeAll(EventSink.layer, ProjectionMaintenance.layer).pipe(
  Layer.provideMerge(stores),
);
it.layer(testLayer)("LegacyHistoryWriter", (it) => {
  it.effect("imports history, frozen costs and a resumable conversation once", () =>
    Effect.gen(function* () {
      const write = yield* makeLegacyHistoryWriter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const threadId = ThreadId.make("synthetic-import-thread");
      const projectId = ProjectId.make("synthetic-import-project");
      const at = IsoDateTime.make("2026-01-01T00:00:00.000Z");
      const event = (
        type: OrchestrationEvent["type"],
        payload: unknown,
        id: string,
      ): Omit<OrchestrationEvent, "sequence"> =>
        Schema.decodeUnknownSync(OrchestrationEvent)({
          sequence: 0,
          eventId: EventId.make(id),
          type,
          aggregateKind: type.startsWith("project.") ? "project" : "thread",
          aggregateId: type.startsWith("project.") ? projectId : threadId,
          occurredAt: at,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload,
        });
      const events = [
        event(
          "project.created",
          {
            projectId,
            title: "Synthetic import",
            workspaceRoot: "/synthetic/import",
            defaultModelSelection: null,
            scripts: [],
            createdAt: at,
            updatedAt: at,
          },
          "import-project",
        ),
        event(
          "thread.created",
          {
            threadId,
            projectId,
            title: "Imported thread",
            modelSelection: { instanceId: "codex", model: "historical-model" },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: at,
            updatedAt: at,
          },
          "import-thread",
        ),
        event(
          "thread.message-sent",
          {
            threadId,
            messageId: "import-message",
            role: "assistant",
            text: "Recorded answer",
            turnId: "legacy-turn",
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
          "import-answer",
        ),
        event(
          "thread.activity-appended",
          {
            threadId,
            activity: {
              id: "usage-event",
              tone: "info",
              sequence: 1,
              kind: "turn.usage",
              summary: "Recorded usage",
              turnId: "legacy-turn",
              createdAt: at,
              payload: {
                usageScope: "main_agent",
                usageStatus: "complete",
                hasSubagents: false,
                inputTokens: 800,
                outputTokens: 50,
                costUsd: 12.345,
                model: "historical-model",
                thread: {
                  inputTokens: 800,
                  outputTokens: 50,
                  cachedInputTokens: 0,
                  cacheCreationTokens: 0,
                  reasoningTokens: 0,
                  countedTurns: 1,
                  turns: 2,
                  partialTurns: 0,
                  subagentTurns: 0,
                  costUsd: 12.345,
                  pricedTurns: 1,
                },
              },
            },
          },
          "import-usage",
        ),
        event(
          "thread.activity-appended",
          {
            threadId,
            activity: {
              id: "model-only-event",
              tone: "info",
              sequence: 2,
              kind: "turn.usage",
              summary: "Recorded model",
              turnId: "model-only-turn",
              createdAt: "2026-01-02T00:00:00.000Z",
              payload: { model: "another-historical-model" },
            },
          },
          "import-model-only",
        ),
        // A resumed provider can put an older record later in sequence order.
        event(
          "thread.activity-appended",
          {
            threadId,
            activity: {
              id: "older-usage-event",
              tone: "info",
              sequence: 3,
              kind: "turn.usage",
              summary: "Older usage",
              turnId: "legacy-turn",
              createdAt: "2025-12-31T00:00:00.000Z",
              payload: {
                usageScope: "main_agent",
                usageStatus: "complete",
                hasSubagents: false,
                inputTokens: 1,
                outputTokens: 1,
                costUsd: 0.001,
              },
            },
          },
          "import-older-usage",
        ),
        event(
          "thread.activity-appended",
          {
            threadId,
            activity: {
              id: "command-start",
              tone: "tool",
              kind: "tool.started",
              summary: "Command started",
              turnId: "legacy-turn",
              createdAt: "2025-12-30T00:00:00.000Z",
              payload: {
                toolCallId: "same-command",
                itemType: "command_execution",
                status: "inProgress",
                data: { item: { command: "cat synthetic.txt" } },
              },
            },
          },
          "command-start-event",
        ),
        event(
          "thread.activity-appended",
          {
            threadId,
            activity: {
              id: "command-end",
              tone: "tool",
              kind: "tool.completed",
              summary: "Command finished",
              turnId: "legacy-turn",
              createdAt: "2025-12-30T00:00:01.000Z",
              payload: {
                toolCallId: "same-command",
                itemType: "command_execution",
                status: "completed",
                data: {
                  item: {
                    command: "cat synthetic.txt",
                    aggregatedOutput: "Synthetic output",
                    exitCode: 0,
                  },
                },
                preservedUnknownField: { nested: ["exact", 42] },
              },
            },
          },
          "command-end-event",
        ),
        event(
          "thread.activity-appended",
          {
            threadId,
            activity: {
              id: "historical-file",
              tone: "tool",
              kind: "tool.completed",
              summary: "Edited file",
              turnId: "legacy-turn",
              createdAt: at,
              payload: {
                itemType: "file_change",
                data: {
                  item: {
                    fileName: "synthetic.ts",
                    additions: 3,
                    deletions: 1,
                    diff: "synthetic diff",
                  },
                },
              },
            },
          },
          "file-change-event",
        ),
        event(
          "thread.activity-appended",
          {
            threadId,
            activity: {
              id: "historical-agent",
              tone: "tool",
              kind: "tool.completed",
              summary: "Agent finished",
              turnId: "legacy-turn",
              createdAt: at,
              payload: {
                itemType: "collab_agent_tool_call",
                data: { item: { prompt: "Synthetic task", result: "Synthetic result" } },
              },
            },
          },
          "subagent-event",
        ),
        event(
          "thread.activity-appended",
          {
            threadId,
            activity: {
              id: "historical-unknown",
              tone: "tool",
              kind: "tool.completed",
              summary: "Custom tool",
              turnId: "legacy-turn",
              createdAt: at,
              payload: {
                itemType: "future_tool",
                toolName: "synthetic_tool",
                data: { rawInput: { exact: [1, 2] }, rawOutput: { synthetic: true } },
              },
            },
          },
          "unknown-tool-event",
        ),
        event(
          "thread.turn-diff-completed",
          {
            threadId,
            turnId: "legacy-turn",
            checkpointTurnCount: 0,
            checkpointRef: "refs/styal/checkpoints/synthetic",
            status: "missing",
            files: [{ path: "synthetic.ts", kind: "modified", additions: 3, deletions: 1 }],
            assistantMessageId: "import-message",
            completedAt: at,
          },
          "historical-checkpoint-event",
        ),
        ...Array.from({ length: 2001 }, (_, index) =>
          event(
            "thread.message-sent",
            {
              threadId,
              messageId: `long-history-${index}`,
              role: "user",
              text: `Synthetic history ${index}`,
              turnId: null,
              streaming: false,
              createdAt: at,
              updatedAt: at,
            },
            `long-history-event-${index}`,
          ),
        ),
      ];
      const options = {
        continuation: {
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access" as const,
          lastSeenAt: at,
          resumeCursor: { threadId: "synthetic-native-id" },
        },
      };
      yield* write(events, options);
      const before = yield* projections.getThreadProjection(threadId);
      assert.equal(before.messages[0]?.text, "Recorded answer");
      assert.equal(before.messages.length, 2002);
      assert.equal(before.messages.at(-1)?.text, "Synthetic history 2000");
      assert.equal(before.messages[0]?.legacyTurnId, "legacy-turn");
      assert.equal(before.legacyTurnUsage?.records[0]?.usage?.costUsd, 12.345);
      assert.equal(before.legacyTurnUsage?.thread.costUsd, 12.345);
      assert.equal(before.legacyTurnUsage?.thread.turns, 2);
      assert.equal(
        before.legacyTurnUsage?.records.find((record) => record.turnId === "model-only-turn")?.model
          ?.model,
        "another-historical-model",
      );
      assert.equal(before.providerThreads[0]?.nativeThreadRef?.nativeId, "synthetic-native-id");
      assert.isNull(before.providerThreads[0]?.providerSessionId);
      const command = before.turnItems.find((item) => item.type === "command_execution");
      assert.isDefined(command);
      assert.equal(command?.type === "command_execution" && command.input, "cat synthetic.txt");
      assert.equal(command?.type === "command_execution" && command.output, "Synthetic output");
      assert.equal(command?.legacyTurnId, "legacy-turn");
      assert.deepEqual(
        command?.legacyActivities?.map((activity) => activity.id),
        ["command-start", "command-end"],
      );
      assert.deepEqual(command?.legacyActivities?.[1]?.payload, {
        toolCallId: "same-command",
        itemType: "command_execution",
        status: "completed",
        data: {
          item: { command: "cat synthetic.txt", aggregatedOutput: "Synthetic output", exitCode: 0 },
        },
        preservedUnknownField: { nested: ["exact", 42] },
      });
      const file = before.turnItems.find((item) => item.type === "file_change");
      assert.equal(file?.type === "file_change" && file.fileName, "synthetic.ts");
      assert.equal(file?.type === "file_change" && file.diffStr, "synthetic diff");
      assert.equal(before.subagents[0]?.result, "Synthetic result");
      assert.isTrue(
        before.nodes.every((node) => !node.countsForRun && node.status === "completed"),
      );
      assert.equal(before.providerSessions.length, 0);
      assert.equal(before.runs.length, 0);
      const custom = before.turnItems.find((item) => item.type === "dynamic_tool");
      assert.deepEqual(custom?.type === "dynamic_tool" && custom.input, { exact: [1, 2] });
      assert.deepEqual(custom?.type === "dynamic_tool" && custom.output, { synthetic: true });
      assert.equal(before.checkpoints[0]?.legacyCheckpointTurnCount, 0);
      assert.equal(before.checkpoints[0]?.legacyTurnId, "legacy-turn");
      assert.equal(before.checkpoints[0]?.assistantMessageId, "import-message");
      assert.equal(before.checkpoints[0]?.ref, "refs/styal/checkpoints/synthetic");
      assert.equal(before.checkpoints[0]?.status, "missing");
      assert.deepEqual(before.checkpoints[0]?.files, [
        { path: "synthetic.ts", kind: "modified", additions: 3, deletions: 1 },
      ]);
      assert.equal(before.checkpointScopes[0]?.kind, "manual");
      assert.isFalse(before.checkpointScopes[0]!.advancesAppRunCount);
      assert.isTrue(
        command!.ordinal <
          before.turnItems.find((item) => item.type === "assistant_message")!.ordinal,
      );

      yield* write(events, options);
      const after = yield* projections.getThreadProjection(threadId);
      assert.deepEqual(after, before);
      yield* maintenance.compactEventStore;
      assert.isTrue((yield* maintenance.rebuild).valid);
      yield* write(events, options);
      assert.deepEqual(yield* projections.getThreadProjection(threadId), before);
      const repair = [
        event(
          "thread.turn-prompt-linked",
          {
            threadId,
            turnId: "repaired-turn",
            messageId: "long-history-0",
            requestedAt: at,
            startedAt: at,
            sourceTurnStartEventId: "synthetic-turn-start",
            sourceSessionEventId: "synthetic-session",
          },
          "synthetic-prompt-repair",
        ),
      ];
      yield* write(repair);
      const repaired = yield* projections.getThreadProjection(threadId);
      assert.equal(
        repaired.messages.find((message) => message.id === "long-history-0")?.legacyTurnId,
        "repaired-turn",
      );
      const repairedItem = repaired.turnItems.find(
        (item) => item.type === "user_message" && item.messageId === "long-history-0",
      );
      assert.equal(
        repairedItem?.type === "user_message" && repairedItem.legacyTurnId,
        "repaired-turn",
      );
      assert.deepEqual(repaired.legacyTurnUsage, before.legacyTurnUsage);
      yield* maintenance.compactEventStore;
      assert.isTrue((yield* maintenance.rebuild).valid);
      yield* write(repair);
      assert.deepEqual(yield* projections.getThreadProjection(threadId), repaired);
    }),
  );
});
