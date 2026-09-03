// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService, layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import { makeLegacyImportService, readLegacySourceSnapshot } from "./LegacyImport.ts";

function createLegacyDatabase(databasePath: string): void {
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
    INSERT INTO projection_projects VALUES (
      'project-import', 'Imported project', '/work/import', NULL,
      '2026-01-01T00:00:00.000Z', NULL
    );
    INSERT INTO projection_threads VALUES ('thread-import', 'project-import', NULL);
  `);

  const insert = database.prepare(`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, '{}')
  `);
  const at = "2026-01-01T00:00:00.000Z";
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
    "event-turn-start",
    "thread",
    "thread-import",
    1,
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
    2,
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
    "event-message-one",
    "thread",
    "thread-import",
    3,
    "thread.message-sent",
    at,
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
      createdAt: at,
      updatedAt: at,
    }),
  );
  insert.run(
    "event-message-two",
    "thread",
    "thread-import",
    4,
    "thread.message-sent",
    at,
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
      createdAt: at,
      updatedAt: at,
    }),
  );
  insert.run(
    "event-progress-one",
    "thread",
    "thread-import",
    5,
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
    6,
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
    7,
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
    "event-title",
    "thread",
    "thread-import",
    8,
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
        assert.strictEqual(snapshot.sourceKind, "t3-code-yngatech");
        assert.deepStrictEqual(snapshot.projects[0]?.threadIds, [ThreadId.make("thread-import")]);
        assert.deepStrictEqual(
          snapshot.projects[0]?.events.map((event) => event.type),
          [
            "project.created",
            "thread.created",
            "thread.message-sent",
            "thread.activity-appended",
            "thread.meta-updated",
          ],
        );
        const messageEvent = snapshot.projects[0]?.events.at(2);
        assert.strictEqual(messageEvent?.type, "thread.message-sent");
        if (messageEvent?.type === "thread.message-sent") {
          assert.strictEqual(messageEvent.payload.text, "Hello there");
          assert.isFalse(messageEvent.payload.streaming);
        }
        const activityEvent = snapshot.projects[0]?.events.at(3);
        assert.strictEqual(activityEvent?.type, "thread.activity-appended");
        if (activityEvent?.type === "thread.activity-appended") {
          assert.strictEqual(activityEvent.payload.activity.summary, "Final progress update");
        }
        const titleEvent = snapshot.projects[0]?.events.at(-1);
        assert.strictEqual(titleEvent?.type, "thread.meta-updated");
        if (titleEvent?.type === "thread.meta-updated") {
          assert.deepStrictEqual(titleEvent.payload, {
            threadId: ThreadId.make("thread-import"),
            title: "Finished title",
            updatedAt: "2026-01-01T00:00:00.000Z",
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

it.effect("imports selected history and safe preferences independently", () => {
  const tempDirectory = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "t3-legacy-import-service-test-"),
  );
  const sourceStateDir = NodePath.join(tempDirectory, "legacy-userdata");
  NodeFS.mkdirSync(sourceStateDir, { recursive: true });
  const sourceDatabasePath = NodePath.join(sourceStateDir, "state.sqlite");
  createLegacyDatabase(sourceDatabasePath);
  // A stale attachment record should not strand an otherwise valid thread.
  addLegacyAttachment(sourceDatabasePath);
  NodeFS.writeFileSync(
    NodePath.join(sourceStateDir, "settings.json"),
    JSON.stringify({
      defaultThreadEnvMode: "local",
      newWorktreesStartFromOrigin: false,
      providers: { codex: { binaryPath: "/legacy/provider-binary" } },
    }),
  );

  const importedBatches: Array<ReadonlyArray<Omit<OrchestrationEvent, "sequence">>> = [];
  const engine = OrchestrationEngineService.of({
    readEvents: () => Stream.empty,
    dispatch: () => Effect.succeed({ sequence: 0 }),
    importHistoricalEvents: (events) =>
      Effect.sync(() => {
        importedBatches.push(events);
        return { eventCount: events.length, sequence: events.length };
      }),
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(0),
  });
  const emptyReadModel: OrchestrationReadModel = {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const emptyShell: OrchestrationShellSnapshot = {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const snapshots = ProjectionSnapshotQuery.of({
    getCommandReadModel: () => Effect.succeed(emptyReadModel),
    getSnapshot: () => Effect.succeed(emptyReadModel),
    getShellSnapshot: () => Effect.succeed(emptyShell),
    getArchivedShellSnapshot: () => Effect.succeed(emptyShell),
    searchThreads: () => Effect.succeed({ matches: [] }),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
    getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
    getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
    getProjectShellById: () => Effect.succeed(Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
    getThreadCheckpointContext: () => Effect.succeed(Option.none()),
    getFullThreadDiffContext: () => Effect.succeed(Option.none()),
    getThreadShellById: () => Effect.succeed(Option.none()),
    getThreadDetailById: () => Effect.succeed(Option.none()),
    getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
  } satisfies ProjectionSnapshotQueryShape);

  const dependencies = Layer.mergeAll(
    Layer.succeed(OrchestrationEngineService, engine),
    Layer.succeed(ProjectionSnapshotQuery, snapshots),
    serverSettingsLayerTest(),
    NodeServices.layer,
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-import-target-test-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* makeLegacyImportService({ sourceStateDir });
    const projectResult = yield* service.importData({
      projectIds: ["project-import"],
      includeSettings: false,
    });
    const settingsBeforePreferenceImport = yield* ServerSettingsService.pipe(
      Effect.flatMap((service) => service.getSettings),
    );

    assert.strictEqual(projectResult.importedProjectCount, 1);
    assert.strictEqual(projectResult.importedThreadCount, 1);
    assert.strictEqual(projectResult.skippedAttachmentCount, 1);
    assert.strictEqual(projectResult.projects[0]?.skippedAttachmentCount, 1);
    assert.isUndefined(projectResult.settings);
    assert.strictEqual(settingsBeforePreferenceImport.defaultThreadEnvMode, "worktree");
    assert.isTrue(settingsBeforePreferenceImport.newWorktreesStartFromOrigin);
    assert.strictEqual(importedBatches.length, 1);
    assert.deepStrictEqual(
      importedBatches[0]?.map((event) => event.type),
      [
        "project.created",
        "thread.created",
        "thread.message-sent",
        "thread.activity-appended",
        "thread.meta-updated",
      ],
    );
    const importedMessage = importedBatches[0]?.find(
      (event) => event.type === "thread.message-sent",
    ) as
      | Omit<Extract<OrchestrationEvent, { readonly type: "thread.message-sent" }>, "sequence">
      | undefined;
    assert.strictEqual(importedMessage?.type, "thread.message-sent");
    if (importedMessage?.type === "thread.message-sent") {
      assert.deepStrictEqual(importedMessage.payload.attachments, []);
    }

    const preferenceResult = yield* service.importData({
      projectIds: [],
      includeSettings: true,
    });
    const settings = yield* ServerSettingsService.pipe(
      Effect.flatMap((service) => service.getSettings),
    );

    assert.strictEqual(preferenceResult.importedProjectCount, 0);
    assert.strictEqual(preferenceResult.importedThreadCount, 0);
    assert.strictEqual(preferenceResult.skippedAttachmentCount, 0);
    assert.strictEqual(preferenceResult.settings?.status, "imported");
    assert.strictEqual(importedBatches.length, 1);
    assert.strictEqual(settings.defaultThreadEnvMode, "local");
    assert.isFalse(settings.newWorktreesStartFromOrigin);
    assert.notStrictEqual(settings.providers.codex.binaryPath, "/legacy/provider-binary");
  }).pipe(
    Effect.provide(dependencies),
    Effect.scoped,
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(tempDirectory, { recursive: true, force: true })),
    ),
  );
});

it.effect("imports one thread at a time and resumes after an interrupted thread", () => {
  const tempDirectory = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "t3-legacy-import-resume-test-"),
  );
  const sourceStateDir = NodePath.join(tempDirectory, "legacy-userdata");
  const sourceDatabasePath = NodePath.join(sourceStateDir, "state.sqlite");
  const sourceAttachmentsDir = NodePath.join(sourceStateDir, "attachments");
  NodeFS.mkdirSync(sourceAttachmentsDir, { recursive: true });
  createLegacyDatabase(sourceDatabasePath);
  addSecondLegacyThread(sourceDatabasePath);
  addLegacyAttachment(sourceDatabasePath);
  NodeFS.writeFileSync(NodePath.join(sourceAttachmentsDir, `${importedAttachmentId}.txt`), "notes");

  const importedProjectIds = new Set<string>();
  const importedThreadIds = new Set<string>();
  const importedBatches: Array<ReadonlyArray<Omit<OrchestrationEvent, "sequence">>> = [];
  let targetAttachmentsDir = "";
  const engine = OrchestrationEngineService.of({
    readEvents: () => Stream.empty,
    dispatch: () => Effect.succeed({ sequence: 0 }),
    importHistoricalEvents: (events) =>
      Effect.suspend(() => {
        importedBatches.push(events);
        if (importedBatches.length === 1) {
          assert.strictEqual(
            NodeFS.readFileSync(
              NodePath.join(targetAttachmentsDir, `${importedAttachmentId}.txt`),
              "utf8",
            ),
            "notes",
          );
          return Effect.die(new Error("simulated interruption"));
        }
        for (const event of events) {
          if (event.type === "project.created") importedProjectIds.add(event.aggregateId);
          if (event.type === "thread.created") importedThreadIds.add(event.aggregateId);
        }
        return Effect.succeed({ eventCount: events.length, sequence: events.length });
      }),
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(0),
  });
  const emptyReadModel: OrchestrationReadModel = {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const emptyShell: OrchestrationShellSnapshot = {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const snapshots = ProjectionSnapshotQuery.of({
    getCommandReadModel: () => Effect.succeed(emptyReadModel),
    getSnapshot: () => Effect.succeed(emptyReadModel),
    getShellSnapshot: () => Effect.succeed(emptyShell),
    getArchivedShellSnapshot: () => Effect.succeed(emptyShell),
    searchThreads: () => Effect.succeed({ matches: [] }),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
    getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
    getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
    getProjectShellById: () =>
      Effect.sync(() =>
        importedProjectIds.has("project-import")
          ? Option.some(importedProjectShell())
          : Option.none(),
      ),
    getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
    getThreadCheckpointContext: () => Effect.succeed(Option.none()),
    getFullThreadDiffContext: () => Effect.succeed(Option.none()),
    getThreadShellById: () => Effect.succeed(Option.none()),
    getThreadDetailById: () => Effect.succeed(Option.none()),
    getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
  } satisfies ProjectionSnapshotQueryShape);
  const dependencies = Layer.mergeAll(
    Layer.succeed(OrchestrationEngineService, engine),
    Layer.succeed(ProjectionSnapshotQuery, snapshots),
    serverSettingsLayerTest(),
    NodeServices.layer,
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-import-resume-target-test-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  );
  const loadDestinationState = () =>
    Effect.succeed({
      projectIds: new Set(importedProjectIds),
      activeWorkspaceRoots: new Set(importedProjectIds.size === 0 ? [] : ["/work/import"]),
      threadIds: new Set(importedThreadIds),
    });

  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    targetAttachmentsDir = config.attachmentsDir;
    const service = yield* makeLegacyImportService({
      sourceStateDir,
      loadDestinationState,
    });

    const interrupted = yield* service.importData({
      projectIds: ["project-import"],
      includeSettings: false,
    });
    assert.strictEqual(interrupted.projects[0]?.status, "failed");
    assert.strictEqual(interrupted.importedThreadCount, 1);
    assert.deepStrictEqual(Array.from(importedThreadIds), ["thread-second"]);
    assert.deepStrictEqual(
      importedBatches.map(
        (events) => `${events.find((event) => event.type === "thread.created")?.aggregateId}`,
      ),
      ["thread-import", "thread-second"],
    );
    assert.isTrue(importedBatches[0]?.some((event) => event.type === "project.created"));
    assert.isTrue(importedBatches[1]?.some((event) => event.type === "project.created"));

    const sourceDatabase = new NodeSqlite.DatabaseSync(sourceDatabasePath);
    sourceDatabase
      .prepare("UPDATE orchestration_events SET payload_json = ? WHERE event_id = ?")
      .run("not valid json", "event-thread-second");
    sourceDatabase.close();

    const resumed = yield* service.importData({
      projectIds: ["project-import"],
      includeSettings: false,
    });
    assert.strictEqual(resumed.projects[0]?.status, "merged");
    assert.strictEqual(resumed.importedThreadCount, 1);
    assert.deepStrictEqual(Array.from(importedThreadIds).sort(), [
      "thread-import",
      "thread-second",
    ]);
    assert.isFalse(importedBatches[2]?.some((event) => event.type === "project.created"));

    const complete = yield* service.importData({
      projectIds: ["project-import"],
      includeSettings: false,
    });
    assert.strictEqual(complete.projects[0]?.status, "skipped");
    assert.strictEqual(importedBatches.length, 3);
  }).pipe(
    Effect.provide(dependencies),
    Effect.scoped,
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(tempDirectory, { recursive: true, force: true })),
    ),
  );
});
