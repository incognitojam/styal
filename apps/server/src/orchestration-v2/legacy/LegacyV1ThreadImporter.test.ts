import { assert, it } from "@effect/vitest";
import {
  ComposerContextId,
  EventId,
  type OrchestrationMessageContext,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { listLinkedPullRequestThreads } from "../../pullRequest/linkedThreads.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import * as ProjectionStore from "../ProjectionStore.ts";

const encodeHistoryJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const layerDatabase = SqlitePersistence.layerMemory;
const layerEventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(layerDatabase));
const layerProjectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase));
const layerStoresProvided = Layer.mergeAll(
  layerDatabase,
  layerEventStoreProvided,
  layerProjectionStoreProvided,
);
const layerEventSinkProvided = EventSink.layer.pipe(Layer.provide(layerStoresProvided));
const layerImporterProvided = LegacyV1ThreadImporter.layer.pipe(
  Layer.provide(Layer.mergeAll(layerStoresProvided, layerEventSinkProvided)),
);
const layerProjectionMaintenanceProvided = ProjectionMaintenance.layer.pipe(
  Layer.provide(layerStoresProvided),
);
const layerTest = Layer.mergeAll(
  layerStoresProvided,
  layerEventSinkProvided,
  layerImporterProvided,
  layerProjectionMaintenanceProvided,
);

const seedPendingTranscripts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const threadIds = [ThreadId.make("thread:first"), ThreadId.make("thread:later")];
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at
    ) VALUES (
      'project:background', 'Legacy project', '/tmp/legacy-background', '[]',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )
  `;
  for (const threadId of threadIds) {
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at
      ) VALUES (
        ${threadId}, 'project:background', 'Legacy thread',
        '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES
        (${`${threadId}:old`}, ${threadId}, 'user', 'Old question', 0,
          '2026-01-01T01:00:00.000Z', '2026-01-01T01:00:00.000Z'),
        (${`${threadId}:latest`}, ${threadId}, 'user', 'Latest question', 0,
          '2026-01-02T01:00:00.000Z', '2026-01-02T01:00:00.000Z')
    `;
  }
  yield* importer.reconcileShells;
});

it.effect(
  "keeps hydrating later transcripts after a defect and leaves the failed thread pending",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* seedPendingTranscripts;
      yield* sql`
        UPDATE projection_thread_messages SET created_at = '0000-not-a-date'
        WHERE message_id = 'thread:first:old'
      `;

      yield* importer.importPendingTranscripts;

      const later = yield* projections.getThreadProjection(ThreadId.make("thread:later"));
      assert.deepStrictEqual(
        later.messages.map((message) => message.text),
        ["Old question", "Latest question"],
      );
      assert.deepStrictEqual(
        yield* sql`
          SELECT thread_id, transcript_imported_at, last_error FROM orchestration_v2_legacy_imports
          WHERE transcript_imported_at IS NULL OR last_error IS NOT NULL
        `,
        [
          {
            thread_id: "thread:first",
            transcript_imported_at: null,
            last_error: "Transcript hydration failed; retry on next open.",
          },
        ],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("propagates interruption from transcript reads and retry-marker writes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    yield* seedPendingTranscripts;
    const interrupted = [];
    for (const phase of ["transcript", "retry-marker"]) {
      const exit = yield* importer.importPendingTranscripts.pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) => {
          const [query] = statement.compile();
          const readingTranscript = query.includes("FROM projection_thread_messages");
          const writingRetryMarker = query.includes("SET last_error =");
          if (phase === "retry-marker" && readingTranscript) {
            return Effect.die("transcript read failed");
          }
          if (phase === "transcript" ? readingTranscript : writingRetryMarker) {
            return Effect.interrupt;
          }
          return Effect.succeed(statement);
        }),
        Effect.exit,
      );
      interrupted.push(Exit.hasInterrupts(exit));
    }
    assert.deepStrictEqual(interrupted, [true, true]);
    assert.deepStrictEqual(
      yield* sql`
        SELECT thread_id FROM orchestration_v2_legacy_imports
        WHERE transcript_imported_at IS NOT NULL OR last_error IS NOT NULL
      `,
      [],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.layer(layerTest)("LegacyV1ThreadImporter", (it) => {
  it.effect(
    "preserves recorded usage and cost, without duplication after replay or compaction",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        const threadId = ThreadId.make("thread:legacy-usage");
        const at = "2026-01-01T00:00:00.000Z";
        yield* sql`
        INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('project:legacy-usage', 'Usage migration', '/synthetic/project', '[]', ${at}, ${at})
      `;
        yield* sql`
        INSERT INTO projection_threads (thread_id, project_id, title, runtime_mode, interaction_mode, created_at, updated_at)
        VALUES (${threadId}, 'project:legacy-usage', 'Usage history', 'full-access', 'default', ${at}, ${at})
      `;
        yield* sql`
        INSERT INTO provider_session_runtime (thread_id, provider_name, provider_instance_id, adapter_key, status, runtime_mode, resume_cursor_json, last_seen_at)
        VALUES (${threadId}, 'codex', 'codex', 'codex', 'stopped', 'full-access', '{"threadId":"synthetic-native-conversation"}', ${at})
      `;
        const first = {
          usageScope: "main_agent",
          usageStatus: "complete",
          hasSubagents: false,
          inputTokens: 1234,
          outputTokens: 56,
          cachedInputTokens: 400,
          costUsd: 0.00321,
          model: "historical-model",
        };
        const second = {
          usageScope: "main_agent",
          usageStatus: "partial",
          hasSubagents: true,
          inputTokens: 100,
          outputTokens: 10,
          costUsd: 0.005,
          subagents: { inputTokens: 20, outputTokens: 5 },
          model: "another-model",
        };
        // Repeated records replace the same turn. A third turn has no reported usage.
        for (const [id, turn, payload] of [
          ["usage:stale", "turn:1", { ...first, inputTokens: 1, costUsd: 99 }],
          ["usage:first", "turn:1", first],
          ["usage:second", "turn:2", second],
          ["usage:model-only", "turn:3", { model: "model-without-usage" }],
        ] as const) {
          yield* sql`
          INSERT INTO styal_legacy_v1_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence)
          VALUES (${id}, ${threadId}, ${turn}, 'info', 'turn.usage', 'Recorded usage', ${encodeHistoryJson(payload)}, ${at}, ${id === "usage:stale" ? 1 : 2})
        `;
        }
        yield* sql`
        INSERT INTO styal_legacy_v1_turns (thread_id, turn_id, state, requested_at, checkpoint_files_json)
        VALUES (${threadId}, 'turn:1', 'completed', ${at}, '[]'),
          (${threadId}, 'turn:2', 'completed', ${at}, '[]'),
          (${threadId}, 'turn:3', 'completed', ${at}, '[]')
      `;
        yield* sql`
        INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, attachments_json, is_streaming, created_at, updated_at)
        VALUES ('message:usage', ${threadId}, 'turn:1', 'assistant', 'Historical answer', '[]', 0, ${at}, ${at})
      `;
        const historicalCommand = {
          itemType: "command_execution",
          toolCallId: "synthetic-command",
          status: "completed",
          data: {
            item: {
              command: "cat synthetic.txt",
              aggregatedOutput: "Recorded output",
              exitCode: 0,
            },
          },
          exactNestedPayload: { keep: [1, 2, 3] },
        };
        yield* sql`
        INSERT INTO styal_legacy_v1_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence)
        VALUES ('synthetic-command-activity', ${threadId}, 'turn:1', 'tool', 'tool.completed', 'Recorded command',
          ${encodeHistoryJson(historicalCommand)}, ${at}, 3)
      `;
        // Runtime bookkeeping is not history; a background task outcome is.
        yield* sql`
        INSERT INTO styal_legacy_v1_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence)
        VALUES ('context-window', ${threadId}, 'turn:1', 'info', 'context-window.updated', 'Context window updated', '{"usedTokens":1}', ${at}, 4),
          ('checkpoint-captured', ${threadId}, 'turn:1', 'info', 'checkpoint.captured', 'Checkpoint captured', '{}', ${at}, 5),
          ('task-completed', ${threadId}, 'turn:1', 'info', 'task.completed', 'Task completed', '{"taskId":"synthetic-task","title":"Run tests","taskType":"local_bash"}', ${at}, 6),
          ('compaction', ${threadId}, 'turn:1', 'info', 'context-compaction', 'Context compacted', '{"detail":{"compact_metadata":{"pre_tokens":1200,"post_tokens":300}}}', ${at}, 7)
      `;
        // V1 could record a last in-progress update at the completion's own timestamp.
        for (const [id, kind, status, sequence] of [
          ["tool-started", "tool.started", "inProgress", 8],
          ["tool-completed", "tool.completed", "completed", 9],
          ["tool-late-update", "tool.updated", "inProgress", 10],
        ] as const) {
          yield* sql`
          INSERT INTO styal_legacy_v1_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence)
          VALUES (${id}, ${threadId}, 'turn:1', 'tool', ${kind}, 'MCP tool call',
            ${encodeHistoryJson({ itemType: "mcp_tool_call", toolCallId: "synthetic-mcp", status, data: { toolName: "synthetic_tool" } })},
            ${sequence === 8 ? at : "2026-01-01T00:00:01.000Z"}, ${sequence})
        `;
        }
        yield* sql`
        UPDATE styal_legacy_v1_turns SET checkpoint_turn_count = 1, checkpoint_ref = 'refs/styal/checkpoints/synthetic',
          checkpoint_status = 'ready', checkpoint_files_json = '[{"path":"synthetic.txt","kind":"modified","additions":2,"deletions":1}]',
          assistant_message_id = 'message:usage', completed_at = ${at}
        WHERE thread_id = ${threadId} AND turn_id = 'turn:1'
      `;
        yield* importer.reconcileShells;
        yield* importer.ensureTranscript(threadId);
        const before = yield* projections.getThreadProjection(threadId);
        assert.equal(
          before.providerThreads[0]?.nativeThreadRef?.nativeId,
          "synthetic-native-conversation",
        );
        assert.isNull(before.providerThreads[0]?.providerSessionId);
        assert.equal(before.thread?.activeProviderThreadId, before.providerThreads[0]?.id);
        assert.equal(before.messages[0]?.legacyTurnId, "turn:1");
        const importedAnswer = before.turnItems.find((item) => item.type === "assistant_message");
        assert.equal(
          importedAnswer?.type === "assistant_message" && importedAnswer.legacyTurnId,
          "turn:1",
        );
        const command = before.turnItems.find((item) => item.type === "command_execution");
        assert.equal(command?.type === "command_execution" && command.input, "cat synthetic.txt");
        assert.equal(command?.type === "command_execution" && command.output, "Recorded output");
        assert.deepEqual(
          command?.legacyActivities?.map((activity) => [activity.id, activity.payload]),
          [["synthetic-command-activity", undefined]],
        );
        assert.equal(command?.type === "command_execution" && command.exitCode, 0);
        assert.equal(command?.legacyTurnId, "turn:1");
        assert.isFalse(before.turnItems.some((item) => item.type === "system_notice"));
        const notification = before.turnItems.find((item) => item.type === "notification");
        assert.deepEqual(
          notification?.type === "notification" && {
            source: notification.source,
            outcome: notification.outcome,
            summary: notification.summary,
          },
          { source: { kind: "command" }, outcome: "completed", summary: "Run tests" },
        );
        const compaction = before.turnItems.find((item) => item.type === "compaction");
        assert.deepEqual(
          compaction?.type === "compaction" && [
            compaction.beforeTokenCount,
            compaction.afterTokenCount,
          ],
          [1200, 300],
        );
        const tool = before.turnItems.find((item) => item.type === "dynamic_tool");
        assert.equal(tool?.status, "completed");
        assert.equal(before.checkpoints[0]?.legacyTurnId, "turn:1");
        assert.equal(before.checkpoints[0]?.assistantMessageId, "message:usage");
        assert.equal(before.checkpoints[0]?.legacyCheckpointTurnCount, 1);
        assert.equal(before.checkpoints[0]?.ref, "refs/styal/checkpoints/synthetic");
        assert.deepEqual(before.checkpoints[0]?.files, [
          { path: "synthetic.txt", kind: "modified", additions: 2, deletions: 1 },
        ]);
        assert.equal(before.checkpointScopes[0]?.kind, "manual");
        assert.equal(before.runs.length, 0);
        assert.equal(before.providerSessions.length, 0);
        assert.equal(before.legacyTurnUsage?.records.length, 3);
        assert.equal(
          before.legacyTurnUsage?.records.find((record) => record.turnId === "turn:1")?.usage
            ?.costUsd,
          0.00321,
        );
        assert.equal(before.legacyTurnUsage?.thread.inputTokens, 1354);
        assert.equal(before.legacyTurnUsage?.thread.outputTokens, 71);
        assert.equal(before.legacyTurnUsage?.thread.turns, 3);
        assert.equal(before.legacyTurnUsage?.thread.countedTurns, 2);
        assert.equal(before.legacyTurnUsage?.thread.partialTurns, 1);
        assert.closeTo(before.legacyTurnUsage!.thread.costUsd!, 0.00821, 1e-12);
        yield* importer.reconcileShells;
        yield* importer.ensureTranscript(threadId);
        yield* maintenance.compactEventStore;
        assert.isTrue((yield* maintenance.rebuild).valid);
        const after = yield* projections.getThreadProjection(threadId);
        assert.deepEqual(after.providerThreads, before.providerThreads);
        assert.deepEqual(after.legacyTurnUsage, before.legacyTurnUsage);
        assert.deepEqual(after.turnItems, before.turnItems);
        assert.deepEqual(after.checkpoints, before.checkpoints);
        assert.deepEqual(after.checkpointScopes, before.checkpointScopes);
        assert.equal(after.messages[0]?.legacyTurnId, "turn:1");
        const events = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_events
        WHERE stream_id = ${threadId} AND event_type = 'legacy-usage.imported'
      `;
        assert.equal(events[0]?.count, 1);
      }),
  );

  it.effect("imports lightweight shells, hydrates transcripts, and remains idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:legacy-import");

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          'project:legacy-import',
          'Legacy project',
          '/tmp/legacy-project',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          unsettled_at,
          snoozed_until,
          snoozed_at,
          pinned_at,
          pin_order_key,
          linked_pull_request_json,
          deleted_at
        ) VALUES (
          ${threadId},
          'project:legacy-import',
          'Migrated conversation',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          ' main ',
          ' /tmp/legacy-project ',
          NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL,
          NULL,
          NULL,
          '2026-01-03T12:00:00.000Z',
          '2026-02-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          'm',
          '{"projectId":"project:legacy-import","repository":"pingdotgg/t3code","number":9000,"url":"https://github.com/pingdotgg/t3code/pull/9000"}',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        ) VALUES
          (
            'message:legacy:1',
            ${threadId},
            NULL,
            'user',
            'First question',
            '[]',
            0,
            '2026-01-01T01:00:00.000Z',
            '2026-01-01T01:00:00.000Z'
          ),
          (
            'message:legacy:2',
            ${threadId},
            NULL,
            'assistant',
            'First answer',
            '[]',
            0,
            '2026-01-02T01:00:00.000Z',
            '2026-01-02T01:00:00.000Z'
          ),
          (
            'message:legacy:3',
            ${threadId},
            NULL,
            'user',
            'Follow-up question',
            '[]',
            0,
            '2026-01-03T01:00:00.000Z',
            '2026-01-03T01:00:00.000Z'
          ),
          (
            'message:legacy:4',
            ${threadId},
            NULL,
            'assistant',
            'Partial answer',
            '[]',
            1,
            '2026-01-04T01:00:00.000Z',
            '2026-01-04T01:00:00.000Z'
        )
      `;

      const validContext = {
        version: 1,
        records: [
          {
            version: 1,
            contextId: ComposerContextId.make("ctx_1"),
            kind: "skill",
            label: "$test",
            name: "test",
          },
        ],
      } satisfies OrchestrationMessageContext;
      yield* sql`
        UPDATE projection_thread_messages
        SET context_json = CASE message_id
          WHEN 'message:legacy:2' THEN '{broken-json'
          WHEN 'message:legacy:3' THEN '{"version":2,"records":[]}'
          ELSE ${JSON.stringify(validContext)}
        END
        WHERE thread_id = ${threadId}
      `;
      const sourceMessages = yield* sql`
        SELECT * FROM projection_thread_messages WHERE thread_id = ${threadId} ORDER BY message_id
      `;

      yield* sql`
        INSERT INTO projection_thread_pull_requests (
          thread_id, host, repository, number, url, source, linked_at, snapshot_json
        ) VALUES
          (${threadId}, 'github.com', 'pingdotgg/t3code', 9002,
            'https://github.com/pingdotgg/t3code/pull/9002', 'created',
            '2026-01-03T00:00:00.000Z',
            '{"state":"open","title":"Second PR","headBranch":"feature-two","baseBranch":"main","isDraft":false,"updatedAt":"2026-01-03T00:00:00.000Z","syncedAt":"2026-01-03T00:00:00.000Z"}'),
          (${threadId}, 'github.com', 'pingdotgg/t3code', 9003,
            'https://github.com/pingdotgg/t3code/pull/9003', 'manual',
            '2026-01-04T00:00:00.000Z', NULL)
      `;

      assert.equal(yield* importer.pendingThreadCount, 1);
      const shellImport = yield* importer.reconcileShells;
      assert.equal(yield* importer.pendingThreadCount, 1);
      assert.deepStrictEqual(shellImport, {
        importedThreadCount: 1,
        importedMessageCount: 2,
      });
      const shellEventCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.equal(shellEventCount[0]?.count, 6);

      assert.isTrue((yield* maintenance.verify).valid);
      const shellProjection = yield* projections.getThreadProjection(threadId);
      assert.equal(shellProjection.thread.historyOrigin, "v1_import");
      assert.equal(shellProjection.thread.branch, "main");
      assert.equal(shellProjection.thread.worktreePath, "/tmp/legacy-project");
      assert.deepEqual(
        shellProjection.thread.pinnedAt,
        DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      );
      assert.equal(shellProjection.thread.pinOrderKey, "m");
      assert.deepEqual(
        shellProjection.thread.snoozedUntil,
        DateTime.makeUnsafe("2026-02-01T00:00:00.000Z"),
      );
      assert.deepEqual(
        shellProjection.thread.unsettledAt,
        DateTime.makeUnsafe("2026-01-03T12:00:00.000Z"),
      );
      assert.equal(shellProjection.thread.linkedPullRequest?.number, 9000);
      assert.deepStrictEqual(
        (shellProjection.thread.pullRequests ?? []).map((link) => link.number),
        [9002, 9003, 9000],
      );
      assert.equal(shellProjection.thread.pullRequests?.[0]?.snapshot?.title, "Second PR");
      assert.deepStrictEqual(
        (yield* listLinkedPullRequestThreads({
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 9002,
        })).threads.map((thread) => thread.id),
        [threadId],
      );
      const shellSnapshot = yield* projections.getShellSnapshot();
      assert.equal(
        shellSnapshot.threads.find((thread) => thread.id === threadId)?.historyOrigin,
        "v1_import",
      );
      assert.deepStrictEqual(
        shellProjection.messages.map((message) => message.id),
        ["message:legacy:3", "message:legacy:4"],
      );
      assert.deepStrictEqual(
        shellProjection.messages.map((message) => [message.text, message.context]),
        [
          ["Follow-up question", undefined],
          ["Partial answer", validContext],
        ],
      );

      const renamedAt = DateTime.makeUnsafe("2026-01-05T00:00:00.000Z");
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:legacy-import:metadata-after-shell"),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: shellProjection.thread.providerInstanceId,
            occurredAt: renamedAt,
            payload: {
              ...shellProjection.thread,
              title: "Renamed after shell import",
              runtimeMode: "approval-required",
              interactionMode: "plan",
              archivedAt: renamedAt,
              settledOverride: "settled",
              settledAt: renamedAt,
              updatedAt: renamedAt,
            },
          },
        ],
      });

      const transcriptImport = yield* importer.importPendingTranscripts;
      assert.equal(yield* importer.pendingThreadCount, 0);
      assert.deepStrictEqual(transcriptImport, {
        importedThreadCount: 1,
        importedMessageCount: 2,
      });
      const projection = yield* projections.getThreadProjection(threadId);
      assert.equal(projection.thread.title, "Renamed after shell import");
      assert.isNull(projection.thread.lastVisitedAt);
      assert.equal(projection.thread.runtimeMode, "approval-required");
      assert.equal(projection.thread.interactionMode, "plan");
      assert.deepEqual(projection.thread.archivedAt, renamedAt);
      assert.equal(projection.thread.settledOverride, "settled");
      assert.deepEqual(projection.thread.settledAt, renamedAt);
      assert.deepStrictEqual(
        projection.messages.map((message) => message.id),
        ["message:legacy:1", "message:legacy:2", "message:legacy:3", "message:legacy:4"],
      );
      const expectedMessages = [
        ["First question", validContext],
        ["First answer", undefined],
        ["Follow-up question", undefined],
        ["Partial answer", validContext],
      ];
      assert.deepStrictEqual(
        projection.messages.map((message) => [message.text, message.context]),
        expectedMessages,
      );
      assert.deepStrictEqual(
        yield* sql`
          SELECT * FROM projection_thread_messages WHERE thread_id = ${threadId} ORDER BY message_id
        `,
        sourceMessages,
      );
      assert.deepStrictEqual(
        projection.turnItems
          .filter(
            (
              item,
            ): item is Extract<
              (typeof projection.turnItems)[number],
              { readonly type: "user_message" | "assistant_message" }
            > => item.type === "user_message" || item.type === "assistant_message",
          )
          .map((item) => [item.messageId, item.ordinal, item.status]),
        [
          ["message:legacy:1", 1, "completed"],
          ["message:legacy:2", 2, "completed"],
          ["message:legacy:3", 3, "completed"],
          ["message:legacy:4", 4, "interrupted"],
        ],
      );

      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:legacy-import:explicit-unpin"),
            type: "thread.unpinned",
            threadId,
            providerInstanceId: projection.thread.providerInstanceId,
            occurredAt: renamedAt,
            payload: { ...projection.thread, pinnedAt: null, pinOrderKey: null },
          },
        ],
      });
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_remove(
          payload_json,
          '$.snoozedUntil',
          '$.snoozedAt',
          '$.unsettledAt',
          '$.linkedPullRequest',
          '$.pullRequests'
        )
        WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 1,
        importedMessageCount: 0,
      });
      const repaired = yield* projections.getThreadProjection(threadId);
      assert.isNull(repaired.thread.pinnedAt);
      assert.isNull(repaired.thread.pinOrderKey);
      assert.deepEqual(
        repaired.thread.snoozedUntil,
        DateTime.makeUnsafe("2026-02-01T00:00:00.000Z"),
      );
      assert.deepEqual(
        repaired.thread.unsettledAt,
        DateTime.makeUnsafe("2026-01-03T12:00:00.000Z"),
      );
      assert.equal(repaired.thread.linkedPullRequest?.number, 9000);
      assert.deepStrictEqual(
        (repaired.thread.pullRequests ?? []).map((link) => link.number),
        [9002, 9003, 9000],
      );
      assert.equal(repaired.thread.pullRequests?.[0]?.snapshot?.title, "Second PR");
      const eventCountBeforeRetry = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });
      assert.deepStrictEqual(yield* importer.ensureTranscript(threadId), {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });
      const eventCountAfterRetry = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.equal(eventCountAfterRetry[0]?.count, eventCountBeforeRetry[0]?.count);
    }),
  );

  it.effect("repairs newly added metadata after an earlier metadata repair", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:legacy-metadata-upgrade");
      const previousRepairId = EventId.make(`migration:v1:thread:${threadId}:metadata-repair`);

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'project:legacy-metadata-upgrade',
          'Legacy project',
          '/tmp/legacy-metadata-upgrade',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, pinned_at, pin_order_key,
          linked_pull_request_json, branch_pull_request_json, active_order_key
        ) VALUES (
          ${threadId},
          'project:legacy-metadata-upgrade',
          'Original v1 title',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          'm',
          '{"projectId":"project:legacy-metadata-upgrade","repository":"pingdotgg/t3code","number":9000,"url":"https://github.com/pingdotgg/t3code/pull/9000"}',
          '{"projectId":"project:legacy-metadata-upgrade","repository":"pingdotgg/t3code","number":9001,"url":"https://github.com/pingdotgg/t3code/pull/9001"}',
          'az'
        )
      `;
      yield* importer.reconcileShells;
      yield* maintenance.rebuild;
      const shellProjection = yield* projections.getThreadProjection(threadId);
      assert.deepStrictEqual(
        (shellProjection.thread.pullRequests ?? []).map((link) => link.number),
        [9000],
      );
      const previousRepairThread = {
        ...shellProjection.thread,
        title: "Renamed in v2",
        pinnedAt: null,
        pinOrderKey: null,
        linkedPullRequest: null,
        pullRequests: [],
      };
      delete previousRepairThread.branchPullRequest;
      delete previousRepairThread.activeOrderKey;
      yield* eventSink.write({
        events: [
          {
            id: previousRepairId,
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: previousRepairThread.providerInstanceId,
            occurredAt: DateTime.makeUnsafe("2026-01-03T00:00:00.000Z"),
            payload: previousRepairThread,
          },
        ],
      });

      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 1,
        importedMessageCount: 0,
      });
      const repaired = yield* projections.getThreadProjection(threadId);
      assert.equal(repaired.thread.title, "Renamed in v2");
      assert.isNull(repaired.thread.pinnedAt);
      assert.isNull(repaired.thread.pinOrderKey);
      assert.isNull(repaired.thread.linkedPullRequest);
      assert.deepStrictEqual(repaired.thread.pullRequests, []);
      assert.equal(repaired.thread.branchPullRequest?.number, 9001);
      assert.equal(repaired.thread.activeOrderKey, "az");

      const eventsBeforeRetry = yield* sql<{ readonly event_id: string }>`
        SELECT event_id
        FROM orchestration_events
        WHERE application_event_version = 2 AND stream_id = ${threadId}
        ORDER BY sequence
      `;
      assert.equal(eventsBeforeRetry.length, 4);
      assert.isTrue(eventsBeforeRetry.some((event) => event.event_id === previousRepairId));
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });

      assert.isTrue((yield* maintenance.rebuild).valid);
      const replayed = yield* projections.getThreadProjection(threadId);
      assert.deepStrictEqual(replayed.thread, repaired.thread);
      assert.deepStrictEqual(
        yield* Effect.gen(function* () {
          const restartedImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
          return yield* restartedImporter.reconcileShells;
        }).pipe(Effect.provide(LegacyV1ThreadImporter.layer)),
        { importedThreadCount: 0, importedMessageCount: 0 },
      );
      const eventsAfterRestart = yield* sql<{ readonly event_id: string }>`
        SELECT event_id
        FROM orchestration_events
        WHERE application_event_version = 2 AND stream_id = ${threadId}
        ORDER BY sequence
      `;
      assert.deepStrictEqual(eventsAfterRestart, eventsBeforeRetry);
    }),
  );
});
