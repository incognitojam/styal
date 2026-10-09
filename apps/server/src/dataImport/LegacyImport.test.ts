// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationProjectShell,
  type ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts/legacy-orchestration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { importLayer } from "./LegacyImport.testkit.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { layerMemory } from "../persistence/Sqlite.ts";
import { makeLegacyHistoryWriter } from "./LegacyHistoryWriter.ts";
import { ServerSettingsService, layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import { makeLegacyImportService, readLegacySourceSnapshot } from "./LegacyImport.ts";
import { legacyContinuationKey } from "./LegacyImportPreview.ts";

export const stopNoActiveProviderSession = (_threadId: ThreadId) => Effect.void;

export function createLegacyDatabase(databasePath: string): void {
  const database = new NodeSqlite.DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      favicon_path TEXT,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE yngatech_sql_migrations (
      migration_id INTEGER NOT NULL,
      name TEXT NOT NULL
    );
    CREATE TABLE orchestration_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      aggregate_kind TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      command_id TEXT,
      causation_event_id TEXT,
      correlation_id TEXT,
      actor_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
    CREATE TABLE provider_session_runtime (
      thread_id TEXT PRIMARY KEY,
      provider_name TEXT NOT NULL,
      provider_instance_id TEXT,
      adapter_key TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      resume_cursor_json TEXT,
      runtime_payload_json TEXT
    );
    INSERT INTO projection_projects VALUES (
      'project-import', 'Imported project', '/work/import', NULL,
      '2026-01-01T00:00:00.000Z', NULL
    );
    INSERT INTO projection_threads VALUES ('thread-import', 'project-import', NULL);
    INSERT INTO provider_session_runtime VALUES (
      'thread-import', 'codex', 'codex', 'codex', 'full-access', 'stopped',
      '2026-01-01T00:00:00.000Z',
      '{"threadId":"provider-thread-import","accessToken":"must-not-cross-import"}', NULL
    );
  `);

  const insert = database.prepare(`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, '{}')
  `);
  const at = "2026-01-01T00:00:00.000Z";
  const subagentAt = "2026-01-01T00:00:10.000Z";
  const assistantAt = "2026-01-01T00:00:15.000Z";
  const completedAt = "2026-01-01T00:00:16.000Z";
  insert.run(
    "event-project",
    "project",
    "project-import",
    0,
    "project.created",
    at,
    "command-project",
    "command-project",
    "client",
    JSON.stringify({
      projectId: "project-import",
      title: "Imported project",
      workspaceRoot: "/work/import",
      defaultModelSelection: null,
      scripts: [],
      createdAt: at,
      updatedAt: at,
    }),
  );
  insert.run(
    "event-thread",
    "thread",
    "thread-import",
    0,
    "thread.created",
    at,
    "command-thread",
    "command-thread",
    "client",
    JSON.stringify({
      threadId: "thread-import",
      projectId: "project-import",
      title: "Imported thread",
      modelSelection: { instanceId: "codex", model: "test-model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: at,
      updatedAt: at,
    }),
  );
  insert.run(
    "event-user-message",
    "thread",
    "thread-import",
    1,
    "thread.message-sent",
    at,
    "command-turn",
    "command-turn",
    "client",
    JSON.stringify({
      threadId: "thread-import",
      messageId: "message-user",
      role: "user",
      text: "Initial prompt",
      attachments: [],
      turnId: null,
      streaming: false,
      createdAt: at,
      updatedAt: at,
    }),
  );
  insert.run(
    "event-turn-start",
    "thread",
    "thread-import",
    2,
    "thread.turn-start-requested",
    at,
    "command-turn",
    "command-turn",
    "client",
    JSON.stringify({
      threadId: "thread-import",
      messageId: "message-user",
      createdAt: at,
    }),
  );
  insert.run(
    "event-session",
    "thread",
    "thread-import",
    3,
    "thread.session-set",
    at,
    null,
    null,
    "server",
    JSON.stringify({
      threadId: "thread-import",
      session: {
        threadId: "thread-import",
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: "turn-one",
        lastError: null,
        updatedAt: at,
      },
    }),
  );
  insert.run(
    "event-subagent-message",
    "thread",
    "thread-import",
    4,
    "thread.message-sent",
    subagentAt,
    null,
    null,
    "provider",
    JSON.stringify({
      threadId: "thread-import",
      messageId: "message-subagent",
      role: "assistant",
      text: "Subagent note",
      turnId: "turn-subagent",
      streaming: false,
      createdAt: subagentAt,
      updatedAt: subagentAt,
    }),
  );
  insert.run(
    "event-message-one",
    "thread",
    "thread-import",
    5,
    "thread.message-sent",
    assistantAt,
    null,
    null,
    "provider",
    JSON.stringify({
      threadId: "thread-import",
      messageId: "message-assistant",
      role: "assistant",
      text: "Hello ",
      turnId: "turn-one",
      streaming: true,
      createdAt: assistantAt,
      updatedAt: assistantAt,
    }),
  );
  insert.run(
    "event-message-two",
    "thread",
    "thread-import",
    6,
    "thread.message-sent",
    assistantAt,
    null,
    null,
    "provider",
    JSON.stringify({
      threadId: "thread-import",
      messageId: "message-assistant",
      role: "assistant",
      text: "Hello there",
      turnId: "turn-one",
      streaming: false,
      createdAt: assistantAt,
      updatedAt: assistantAt,
    }),
  );
  insert.run(
    "event-progress-one",
    "thread",
    "thread-import",
    7,
    "thread.activity-appended",
    at,
    null,
    null,
    "provider",
    JSON.stringify({
      threadId: "thread-import",
      activity: {
        id: "activity-progress",
        tone: "info",
        kind: "task.progress",
        summary: "First progress update",
        payload: { completed: 1 },
        turnId: "turn-one",
        createdAt: at,
      },
    }),
  );
  insert.run(
    "event-progress-two",
    "thread",
    "thread-import",
    8,
    "thread.activity-appended",
    at,
    null,
    null,
    "provider",
    JSON.stringify({
      threadId: "thread-import",
      activity: {
        id: "activity-progress",
        tone: "info",
        kind: "task.progress",
        summary: "Final progress update",
        payload: { completed: 2 },
        turnId: "turn-one",
        createdAt: at,
      },
    }),
  );
  insert.run(
    "event-context-window",
    "thread",
    "thread-import",
    9,
    "thread.activity-appended",
    at,
    null,
    null,
    "provider",
    JSON.stringify({
      threadId: "thread-import",
      activity: {
        id: "activity-context-window",
        tone: "info",
        kind: "context-window.updated",
        summary: "Context window updated",
        payload: { usedTokens: 1 },
        turnId: "turn-one",
        createdAt: at,
      },
    }),
  );
  insert.run(
    "event-turn-diff",
    "thread",
    "thread-import",
    10,
    "thread.turn-diff-completed",
    completedAt,
    null,
    null,
    "server",
    JSON.stringify({
      threadId: "thread-import",
      turnId: "turn-one",
      checkpointTurnCount: 1,
      checkpointRef: "refs/t3/checkpoints/imported/turn/1",
      status: "ready",
      files: [],
      assistantMessageId: "message-assistant",
      completedAt,
    }),
  );
  insert.run(
    "event-title",
    "thread",
    "thread-import",
    11,
    "thread.meta-updated",
    at,
    "command-title",
    "command-title",
    "client",
    JSON.stringify({
      threadId: "thread-import",
      title: "Finished title",
      regenerateTitle: true,
      previousTitle: "Imported thread",
      titleRegeneration: { requestId: "command-title", startedAt: at },
      updatedAt: at,
    }),
  );
  database.close();
}

const importedAttachmentId = "thread-import-00000000-0000-4000-8000-0000000000aa";

function addSecondLegacyThread(databasePath: string): void {
  const database = new NodeSqlite.DatabaseSync(databasePath);
  const at = "2026-01-02T00:00:00.000Z";
  database.exec("INSERT INTO projection_threads VALUES ('thread-second', 'project-import', NULL)");
  database
    .prepare(`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
      ) VALUES (?, 'thread', 'thread-second', 0, 'thread.created', ?, ?, NULL, ?, 'client', ?, '{}')
    `)
    .run(
      "event-thread-second",
      at,
      "command-thread-second",
      "command-thread-second",
      JSON.stringify({
        threadId: "thread-second",
        projectId: "project-import",
        title: "Second imported thread",
        modelSelection: { instanceId: "codex", model: "test-model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: at,
        updatedAt: at,
      }),
    );
  database.close();
}

function addLegacyAttachment(databasePath: string): void {
  const database = new NodeSqlite.DatabaseSync(databasePath);
  const row = database
    .prepare("SELECT payload_json AS payloadJson FROM orchestration_events WHERE event_id = ?")
    .get("event-message-two") as { readonly payloadJson: string };
  const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
  database.prepare("UPDATE orchestration_events SET payload_json = ? WHERE event_id = ?").run(
    JSON.stringify({
      ...payload,
      attachments: [
        {
          type: "file",
          id: importedAttachmentId,
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
        },
      ],
    }),
    "event-message-two",
  );
  database.close();
}

function importedProjectShell(): OrchestrationProjectShell {
  return {
    id: ProjectId.make("project-import"),
    title: "Imported project",
    workspaceRoot: "/work/import",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

it.effect("reads durable history without carrying live provider state", () => {
  const tempDirectory = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "t3-legacy-import-test-"),
  );
  const sourceDatabasePath = NodePath.join(tempDirectory, "legacy.sqlite");
  createLegacyDatabase(sourceDatabasePath);
  const modifiedAtBefore = NodeFS.statSync(sourceDatabasePath, { bigint: true }).mtimeNs;

  return readLegacySourceSnapshot({
    sourceDatabasePath,
    currentDatabasePath: NodePath.join(tempDirectory, "current.sqlite"),
    projectIds: ["project-import"],
  }).pipe(
    Effect.tap((snapshot) =>
      Effect.sync(() => {
        assert.deepStrictEqual(snapshot[0]?.threadIds, [ThreadId.make("thread-import")]);
        assert.deepStrictEqual(snapshot[0]?.continuations.get(ThreadId.make("thread-import")), {
          threadId: ThreadId.make("thread-import"),
          provider: "codex" as ProviderDriverKind,
          providerInstanceId: "codex" as ProviderInstanceId,
          runtimeMode: "full-access",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
          resumeCursor: { threadId: "provider-thread-import" },
        });
        assert.deepStrictEqual(
          snapshot[0]?.events.map((event) => event.type),
          [
            "project.created",
            "thread.created",
            "thread.message-sent",
            "thread.message-sent",
            "thread.message-sent",
            "thread.activity-appended",
            "thread.turn-diff-completed",
            "thread.meta-updated",
            "thread.turn-prompt-linked",
          ],
        );
        const messageEvent = snapshot[0]?.events.find(
          (event) =>
            event.type === "thread.message-sent" && event.payload.messageId === "message-assistant",
        );
        assert.strictEqual(messageEvent?.type, "thread.message-sent");
        if (messageEvent?.type === "thread.message-sent") {
          assert.strictEqual(messageEvent.payload.text, "Hello there");
          assert.isFalse(messageEvent.payload.streaming);
        }
        const activityEvent = snapshot[0]?.events.find(
          (event) => event.type === "thread.activity-appended",
        );
        assert.strictEqual(activityEvent?.type, "thread.activity-appended");
        if (activityEvent?.type === "thread.activity-appended") {
          assert.strictEqual(activityEvent.payload.activity.summary, "Final progress update");
        }
        const titleEvent = snapshot[0]?.events.find(
          (event) => event.type === "thread.meta-updated",
        );
        assert.strictEqual(titleEvent?.type, "thread.meta-updated");
        if (titleEvent?.type === "thread.meta-updated") {
          assert.deepStrictEqual(titleEvent.payload, {
            threadId: ThreadId.make("thread-import"),
            title: "Finished title",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
        }
        const promptLinkEvent = snapshot[0]?.events.at(-1);
        assert.strictEqual(promptLinkEvent?.type, "thread.turn-prompt-linked");
        if (promptLinkEvent?.type === "thread.turn-prompt-linked") {
          assert.deepStrictEqual(promptLinkEvent.payload, {
            threadId: ThreadId.make("thread-import"),
            turnId: TurnId.make("turn-one"),
            messageId: MessageId.make("message-user"),
            requestedAt: "2026-01-01T00:00:00.000Z",
            startedAt: "2026-01-01T00:00:00.000Z",
            sourceTurnStartEventId: EventId.make("event-turn-start"),
            sourceSessionEventId: EventId.make("event-session"),
          });
        }
        assert.strictEqual(
          NodeFS.statSync(sourceDatabasePath, { bigint: true }).mtimeNs,
          modifiedAtBefore,
        );
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(tempDirectory, { recursive: true, force: true })),
    ),
  );
});

it.layer(importLayer)("LegacyImport V2 destination", (it) => {
  it.effect(
    "imports history, safe preferences, missing attachments and resumable context independently",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const sourceStateDir = NodePath.join(config.baseDir, "source");
        NodeFS.mkdirSync(sourceStateDir);
        createLegacyDatabase(NodePath.join(sourceStateDir, "state.sqlite"));
        addLegacyAttachment(NodePath.join(sourceStateDir, "state.sqlite"));
        NodeFS.writeFileSync(
          NodePath.join(sourceStateDir, "settings.json"),
          JSON.stringify({
            defaultThreadEnvMode: "local",
            newWorktreesStartFromOrigin: false,
            providers: { codex: { binaryPath: "/synthetic/provider" } },
          }),
        );
        const destination = {
          projectIds: new Set<string>(),
          activeWorkspaceRoots: new Set<string>(),
          threadIds: new Set<string>(),
          continuationKeys: new Map<string, string>(),
          turnPromptLinkEventIds: new Set<string>(),
          turnIdsByThreadId: new Map<string, Set<string>>(),
        };
        const service = yield* makeLegacyImportService({
          sourceStateDir,
          loadDestinationState: () => Effect.succeed(destination),
          stopActiveProviderSession: stopNoActiveProviderSession,
        });
        const imported = yield* service.importData({
          projectIds: ["project-import"],
          includeSettings: false,
        });
        assert.equal(imported.importedThreadCount, 1);
        assert.equal(imported.skippedAttachmentCount, 1);
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const projection = yield* projections.getThreadProjection(ThreadId.make("thread-import"));
        assert.equal(projection.thread.title, "Finished title");
        assert.deepEqual(
          projection.messages.map((message) => message.text),
          ["Initial prompt", "Subagent note", "Hello there"],
        );
        assert.equal(
          projection.messages.find((message) => message.id === "message-user")?.legacyTurnId,
          "turn-one",
        );
        assert.isFalse(projection.messages.some((message) => message.streaming));
        assert.equal(
          projection.providerThreads[0]?.nativeThreadRef?.nativeId,
          "provider-thread-import",
        );
        assert.equal(projection.providerThreads[0]?.providerSessionId, null);
        assert.deepEqual(projection.providerSessions, []);
        const settingsBefore = yield* (yield* ServerSettingsService).getSettings;
        assert.equal(settingsBefore.defaultThreadEnvMode, null);
        const settingsResult = yield* service.importData({ projectIds: [], includeSettings: true });
        assert.equal(settingsResult.settings?.status, "imported");
        const settingsAfter = yield* (yield* ServerSettingsService).getSettings;
        assert.equal(settingsAfter.defaultThreadEnvMode, "local");
        assert.isFalse(settingsAfter.newWorktreesStartFromOrigin);
        assert.notInclude(JSON.stringify(settingsAfter.providerInstances), "/synthetic/provider");
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        yield* maintenance.compactEventStore;
        yield* maintenance.rebuild;
        assert.deepEqual(
          yield* projections.getThreadProjection(ThreadId.make("thread-import")),
          projection,
        );
        // A failed thread leaves the already imported thread intact and remains retryable.
        destination.projectIds.add("project-import");
        destination.activeWorkspaceRoots.add("/work/import");
        destination.threadIds.add("thread-import");
        destination.continuationKeys.set("thread-import", "codex:codex:provider-thread-import");
        addSecondLegacyThread(NodePath.join(sourceStateDir, "state.sqlite"));
        const sink = yield* EventSink.EventSinkV2;
        let failNext = true;
        const retryService = yield* makeLegacyImportService({
          sourceStateDir,
          loadDestinationState: () => Effect.succeed(destination),
          stopActiveProviderSession: stopNoActiveProviderSession,
        }).pipe(
          Effect.provideService(EventSink.EventSinkV2, {
            ...sink,
            commitCommand: (input) =>
              input.threadId === "thread-second" && failNext
                ? Effect.sync(() => {
                    failNext = false;
                  }).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new EventSink.EventSinkWriteError({
                          eventCount: input.events.length,
                          cause: "Synthetic interruption",
                        }),
                      ),
                    ),
                  )
                : sink.commitCommand(input),
          }),
        );
        const interrupted = yield* retryService.importData({
          projectIds: ["project-import"],
          includeSettings: false,
        });
        assert.equal(interrupted.importedThreadCount, 0);
        assert.equal(
          (yield* Effect.exit(projections.getThreadProjection(ThreadId.make("thread-second"))))
            ._tag,
          "Failure",
        );
        assert.deepEqual(
          yield* projections.getThreadProjection(ThreadId.make("thread-import")),
          projection,
        );
        const retried = yield* retryService.importData({
          projectIds: ["project-import"],
          includeSettings: false,
        });
        assert.equal(retried.importedThreadCount, 1);
        assert.equal(
          (yield* projections.getThreadProjection(ThreadId.make("thread-second"))).thread.title,
          "Second imported thread",
        );
      }),
  );
});
