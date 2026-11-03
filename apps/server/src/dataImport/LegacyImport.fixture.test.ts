import * as ConfigProvider from "effect/ConfigProvider";
import * as TestClock from "effect/testing/TestClock";
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
/** Compare imports against the views captured by an actual upstream server. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import { ThreadId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import { emptyLegacyImportDestinationState } from "./LegacyImportPreview.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { makeLegacyHistoryWriter } from "./LegacyHistoryWriter.ts";
import { readLegacySourceSnapshot } from "./LegacyImport.ts";
import * as References from "effect/References";
import * as Effect from "effect/Effect";
import { ServerConfig } from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Maintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeLegacyImportService } from "./LegacyImport.ts";
import { importLayer } from "./LegacyImport.testkit.ts";

type Json = Record<string, unknown>;
interface Manifest {
  serverRevision: string;
  importedThreadIds: string[];
  deletedThreadIds: string[];
  settings: Json;
  orchestrationVersion?: number;
  databaseFilename?: string;
}
interface View {
  snapshot: { projects: Json[]; threads: Json[] };
  threads: Record<string, Json>;
}
const pruningEnabled = ConfigProvider.layer(
  ConfigProvider.fromEnv({ env: { T3CODE_EVENT_PRUNING: "1" } }),
);

const fixtures = [
  {
    name: "native V2",
    directory:
      process.env.STYAL_T3_IMPORT_FIXTURE ??
      NodePath.join(import.meta.dirname, "testFixtures/t3-code"),
  },
  { name: "legacy V1", directory: NodePath.join(import.meta.dirname, "testFixtures/t3-code-v1") },
];
const readJson = <T>(directory: string, name: string): T =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(directory, name), "utf8")) as T;
const runtimeKinds = new Set([
  "context-window.updated",
  "approval.requested",
  "approval.resolved",
  "user-input.requested",
  "user-input.resolved",
  "provider.approval.respond.failed",
  // Bookkeeping the history importer skips unless grouped with a displayed activity.
  "checkpoint.captured",
  "task.started",
  "task.updated",
  "tool.progress",
  "tool.started",
  "turn.plan.updated",
  "turn.usage",
  "worktree-setup",
]);

for (const fixture of fixtures) {
  // Each source format needs its own destination database and settings.
  it.layer(importLayer)(`real upstream import boundary (${fixture.name})`, (it) => {
    it.effect(
      "preserves recorded thread history, files, preferences and native resume identity across replay",
      () =>
        Effect.gen(function* () {
          const fixtureDir = fixture.directory;
          const config = yield* ServerConfig;
          const manifest = readJson<Manifest>(fixtureDir, "manifest.json");
          const view = readJson<View>(fixtureDir, "t3-view.json");
          // Older upstream settings store the Codex binary under `providers`.
          // Newer ones dropped that map and store it under `providerInstances`.
          const sourceSettings = readJson<{
            readonly providers?: { readonly codex?: { readonly binaryPath?: string } };
            readonly providerInstances?: {
              readonly codex?: { readonly config?: { readonly binaryPath?: string } };
            };
          }>(fixtureDir, "settings.json");
          const sourceCodexBinaryPath =
            sourceSettings.providers?.codex?.binaryPath ??
            sourceSettings.providerInstances?.codex?.config?.binaryPath;
          const destinationSettingsBefore = yield* (yield* ServerSettingsService).getSettings;
          const sourceDir = NodePath.join(config.baseDir, "fixture-source");
          NodeFS.mkdirSync(sourceDir);
          const database = new NodeSqlite.DatabaseSync(
            NodePath.join(
              sourceDir,
              manifest.databaseFilename ??
                (manifest.orchestrationVersion === 2 ? "state-v2.sqlite" : "state.sqlite"),
            ),
          );
          database.exec(NodeFS.readFileSync(NodePath.join(fixtureDir, "state.sql"), "utf8"));
          const sourceActivities = new Map<string, unknown>();
          if (manifest.orchestrationVersion !== 2) {
            for (const row of database
              .prepare(
                "SELECT payload_json FROM orchestration_events WHERE event_type = 'thread.activity-appended' ORDER BY sequence",
              )
              .all()) {
              const activity = JSON.parse(String(row.payload_json)).activity as Json;
              sourceActivities.set(String(activity.id), activity.payload);
            }
          }
          database.close();
          NodeFS.cpSync(
            NodePath.join(fixtureDir, "attachments"),
            NodePath.join(sourceDir, "attachments"),
            { recursive: true },
          );
          NodeFS.copyFileSync(
            NodePath.join(fixtureDir, "settings.json"),
            NodePath.join(sourceDir, "settings.json"),
          );
          const service = yield* makeLegacyImportService({
            sourceStateDir: sourceDir,
            loadDestinationState: () =>
              Effect.succeed({
                projectIds: new Set(),
                activeWorkspaceRoots: new Set(),
                threadIds: new Set(),
                continuationKeys: new Map(),
                turnPromptLinkEventIds: new Set(),
                turnIdsByThreadId: new Map(),
              }),
            stopActiveProviderSession: () => Effect.void,
          });
          const result = yield* service.importData({
            projectIds: view.snapshot.projects.map((project) =>
              String(project.id ?? project.projectId),
            ),
            includeSettings: true,
          });
          if (
            result.importedThreadCount !== manifest.importedThreadIds.length &&
            manifest.orchestrationVersion !== 2
          ) {
            const plans = yield* readLegacySourceSnapshot({
              sourceDatabasePath: NodePath.join(sourceDir, "state.sqlite"),
              currentDatabasePath: config.dbPath,
              projectIds: view.snapshot.projects.map((project) => String(project.id)),
            });
            const write = yield* makeLegacyHistoryWriter;
            for (const plan of plans)
              for (const id of plan.threadIds) {
                const existing = yield* Effect.exit(
                  (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(id),
                );
                if (existing._tag === "Success") continue;
                const outcome = yield* Effect.exit(
                  write(
                    plan.events
                      .filter(
                        (event) => event.aggregateKind === "project" || event.aggregateId === id,
                      )
                      .map(({ sequence: _sequence, ...event }) => event),
                    { continuation: plan.continuations.get(id)! },
                  ),
                );
                if (outcome._tag === "Failure")
                  assert.fail(`${id}: ${Cause.pretty(outcome.cause)}`);
              }
          }
          assert.equal(
            result.importedProjectCount,
            view.snapshot.projects.length,
            JSON.stringify(result),
          );
          assert.equal(result.importedThreadCount, manifest.importedThreadIds.length);
          assert.equal(result.skippedAttachmentCount, 0);
          assert.equal(result.settings?.status, "imported");
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const before = new Map<string, OrchestrationV2ThreadProjection>();
          for (const id of manifest.importedThreadIds) {
            const actual = yield* store.getThreadProjection(ThreadId.make(id));
            before.set(id, actual);
            const expected = view.threads[id]!;
            assert.equal(actual.thread.deletedAt, null, id);
            assert.deepEqual(actual.providerSessions, [], id);
            assert.deepEqual(actual.runtimeRequests, [], id);
            if (manifest.orchestrationVersion === 2) {
              const native = (expected.projection as Json) ?? expected;
              const sourceMessages = native.messages as Json[];
              assert.deepEqual(
                actual.messages.map((message) => ({
                  id: message.id,
                  text: message.text,
                  role: message.role,
                  attachments: message.attachments,
                })),
                sourceMessages.map((message) => ({
                  id: message.id,
                  text: message.text,
                  role: message.role,
                  attachments: message.attachments,
                })),
                id,
              );
              assert.equal(actual.turnItems.length, (native.turnItems as unknown[]).length, id);
              assert.equal(actual.checkpoints.length, (native.checkpoints as unknown[]).length, id);
              assert.deepEqual(
                actual.providerTurns.map((turn) => ({
                  id: turn.id,
                  tokenUsage: turn.tokenUsage,
                  turnTokenUsage: turn.turnTokenUsage,
                  turnModel: turn.turnModel,
                })),
                (native.providerTurns as Json[]).map((turn) => ({
                  id: turn.id,
                  tokenUsage: turn.tokenUsage,
                  turnTokenUsage: turn.turnTokenUsage,
                  turnModel: turn.turnModel,
                })),
                id,
              );
            } else {
              const summary = view.snapshot.threads.find((thread) => thread.id === id) ?? expected;
              for (const field of [
                "id",
                "projectId",
                "title",
                "runtimeMode",
                "interactionMode",
                "branch",
                "worktreePath",
                "modelSelection",
              ])
                assert.deepEqual(
                  actual.thread[field as keyof typeof actual.thread],
                  summary[field],
                  `${id}.${field}`,
                );
              const expectedMessages = (expected.messages as Json[]).filter(
                (message) => message.role === "user" || message.role === "assistant",
              );
              assert.deepEqual(
                actual.messages.map((message) => ({
                  id: message.id,
                  role: message.role,
                  text: message.text,
                  attachments: message.attachments,
                })),
                expectedMessages.map((message) => ({
                  id: message.id,
                  role: message.role,
                  text: message.text,
                  attachments: message.attachments ?? [],
                })),
                `${id}.messages`,
              );
              const activities = actual.turnItems.flatMap((item) => item.legacyActivities ?? []);
              for (const activity of (expected.activities as Json[]).filter(
                (activity) => !runtimeKinds.has(String(activity.kind)),
              )) {
                const imported = activities.find((record) => record.id === activity.id);
                assert.isDefined(imported, `${id}.activity:${activity.id}`);
                // The V1 source keeps the payload; the converted item keeps a reference.
                assert.isDefined(
                  sourceActivities.get(String(activity.id)),
                  `${id}.source:${activity.id}`,
                );
                assert.isUndefined(imported?.payload, `${id}.activity:${activity.id}.payload`);
              }
              const expectedCheckpoints = expected.checkpoints as Json[];
              assert.equal(
                actual.checkpoints.length,
                expectedCheckpoints.length,
                `${id}.checkpoints`,
              );
              for (const checkpoint of expectedCheckpoints) {
                const imported = actual.checkpoints.find(
                  (record) => record.legacyTurnId === checkpoint.turnId,
                );
                assert.isDefined(imported, `${id}.checkpoint:${checkpoint.turnId}`);
                assert.equal(imported?.legacyCheckpointTurnCount, checkpoint.checkpointTurnCount);
                assert.equal(imported?.assistantMessageId, checkpoint.assistantMessageId);
                assert.equal(imported?.ref, checkpoint.checkpointRef);
                assert.deepEqual(imported?.files, checkpoint.files);
              }
            }
            assert.isTrue(
              actual.providerThreads.every((provider) => provider.providerSessionId === null),
            );
          }
          const projects = yield* (yield* ProjectStore.ProjectStoreV2).list();
          assert.equal(projects.length, view.snapshot.projects.length);
          for (const id of manifest.deletedThreadIds)
            assert.equal(
              (yield* Effect.exit(store.getThreadProjection(ThreadId.make(id))))._tag,
              "Failure",
            );
          for (const name of NodeFS.readdirSync(NodePath.join(fixtureDir, "attachments")))
            assert.deepEqual(
              NodeFS.readFileSync(NodePath.join(config.attachmentsDir, name)),
              NodeFS.readFileSync(NodePath.join(fixtureDir, "attachments", name)),
              name,
            );
          const settings = yield* (yield* ServerSettingsService).getSettings;
          for (const [key, value] of Object.entries(manifest.settings))
            assert.deepEqual(
              settings[key as keyof typeof settings],
              key === "responseStreamingMode" && value === "token" ? "paragraph" : value,
              key,
            );
          assert.isNotEmpty(sourceCodexBinaryPath);
          assert.notInclude(JSON.stringify(settings.providerInstances), sourceCodexBinaryPath!);
          assert.deepEqual(settings.providerInstances, destinationSettingsBefore.providerInstances);
          const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
          yield* maintenance.pruneEventStore().pipe(Effect.provide(pruningEnabled));
          yield* TestClock.adjust("1 day");
          assert.isAbove(
            (yield* maintenance.pruneEventStore().pipe(Effect.provide(pruningEnabled)))
              .deletedEventCount,
            0,
          );
          for (const [id, projection] of before)
            assert.deepEqual(yield* store.getThreadProjection(ThreadId.make(id)), projection);
        }).pipe(Effect.provideService(References.MinimumLogLevel, "Warn")),
    );
  });
}

it.effect("imports and repairs pruned V2 sources without changing projected history", () => {
  const importSource = Effect.fn("test.importSource")(
    function* (pruned: boolean) {
      const config = yield* ServerConfig;
      const fixtureDir = fixtures[0]!.directory;
      const manifest = readJson<Manifest>(fixtureDir, "manifest.json");
      const sourceDir = NodePath.join(config.baseDir, "pruned-source");
      NodeFS.mkdirSync(sourceDir);
      const sourceDatabasePath = NodePath.join(sourceDir, manifest.databaseFilename!);
      const database = new NodeSqlite.DatabaseSync(sourceDatabasePath);
      try {
        database.exec(NodeFS.readFileSync(NodePath.join(fixtureDir, "state.sql"), "utf8"));
        database.exec("ALTER TABLE projection_projects ADD COLUMN additional_instructions TEXT");
        const projects = database.prepare("SELECT project_id FROM projection_projects").all();
        for (const row of projects) {
          const projectId = String(row.project_id);
          const created = database
            .prepare(
              "SELECT payload_json FROM orchestration_events WHERE stream_id = ? AND event_type = 'project.created'",
            )
            .get(projectId)!;
          const payload = JSON.parse(String(created.payload_json)) as Json;
          const fields = {
            defaultModelSelection: { instanceId: "codex", model: "synthetic-model" },
            faviconPath: "synthetic.svg",
            additionalInstructions: "Use synthetic fixtures.",
            projectIcon: { kind: "emoji", emoji: "🧪" },
          };
          database
            .prepare(
              "UPDATE orchestration_events SET payload_json = ? WHERE stream_id = ? AND event_type = 'project.created'",
            )
            .run(JSON.stringify({ ...payload, ...fields }), projectId);
          database
            .prepare(
              "UPDATE projection_projects SET default_model_selection_json = ?, favicon_path = ?, additional_instructions = ?, project_icon_json = ? WHERE project_id = ?",
            )
            .run(
              JSON.stringify(fields.defaultModelSelection),
              fields.faviconPath,
              fields.additionalInstructions,
              JSON.stringify(fields.projectIcon),
              projectId,
            );

          const scripts = [
            {
              id: "verify",
              name: "Verify",
              command: "echo synthetic",
              icon: "test",
              runOnWorktreeCreate: false,
            },
          ];
          const updatedAt = "2026-11-01T00:00:00.000Z";
          const update = { projectId, title: `${payload.title} updated`, scripts, updatedAt };
          database
            .prepare(
              "INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version) VALUES (?, 'project', ?, 2, 'project.meta-updated', ?, 'server', ?, '{}', 2)",
            )
            .run(`synthetic-update:${projectId}`, projectId, updatedAt, JSON.stringify(update));
          database
            .prepare(
              "UPDATE projection_projects SET title = ?, scripts_json = ?, updated_at = ? WHERE project_id = ?",
            )
            .run(update.title, JSON.stringify(scripts), updatedAt, projectId);
        }
        database.exec(`
          UPDATE orchestration_v2_projection_provider_turns
          SET payload_json = json_set(payload_json, '$.turnTokenUsage.costUsd', 0.125)
          WHERE json_type(payload_json, '$.turnTokenUsage') = 'object';
        `);
        if (pruned) {
          const deleted = database
            .prepare(`
        DELETE FROM orchestration_events
        WHERE application_event_version = 2
          AND event_type != 'thread.created'
          AND NOT (event_type = 'run.updated' AND json_extract(payload_json, '$.status') = 'running')
          AND sequence NOT IN (SELECT MAX(sequence) FROM orchestration_events GROUP BY aggregate_kind, stream_id);
      `)
            .run();
          assert.isAbove(Number(deleted.changes), 2);
          assert.equal(
            database
              .prepare(
                "SELECT COUNT(*) AS count FROM orchestration_events WHERE event_type = 'project.created'",
              )
              .get()!.count,
            0,
          );
        }
      } finally {
        database.close();
      }
      NodeFS.cpSync(
        NodePath.join(fixtureDir, "attachments"),
        NodePath.join(sourceDir, "attachments"),
        { recursive: true },
      );
      let destination = emptyLegacyImportDestinationState();
      const service = yield* makeLegacyImportService({
        sourceStateDir: sourceDir,
        loadDestinationState: () => Effect.succeed(destination),
        stopActiveProviderSession: () => Effect.void,
      });
      const projectIds = ["project-alpha", "project-beta"];
      const result = yield* service.importData({ projectIds, includeSettings: false });
      assert.equal(result.importedThreadCount, manifest.importedThreadIds.length);
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* Effect.forEach(manifest.importedThreadIds, (id) =>
        store.getThreadProjection(ThreadId.make(id)),
      );
      assert.isTrue(
        threads.some((projection) =>
          projection.providerTurns.some((turn) => turn.turnTokenUsage?.costUsd === 0.125),
        ),
      );
      const projects = yield* (yield* ProjectStore.ProjectStoreV2).list();
      destination = {
        ...destination,
        projectIds: new Set(projectIds),
        threadIds: new Set(manifest.importedThreadIds),
      };
      // Model an older import with event identities distinct from the current V2 writer.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_events SET event_id = 'older-import:' || event_id`;
      const repair = yield* service.importData({ projectIds, includeSettings: false });
      assert.isAbove(repair.repairedThreadCount, 0, JSON.stringify(repair));
      assert.equal(repair.importedThreadCount, 0);
      assert.deepEqual(
        yield* Effect.forEach(manifest.importedThreadIds, (id) =>
          store.getThreadProjection(ThreadId.make(id)),
        ),
        threads,
      );
      if (pruned) {
        const damaged = new NodeSqlite.DatabaseSync(sourceDatabasePath);
        try {
          damaged.exec("DELETE FROM projection_projects WHERE project_id = 'project-alpha'");
        } finally {
          damaged.close();
        }
        const refusal = yield* readLegacySourceSnapshot({
          sourceDatabasePath,
          currentDatabasePath: config.dbPath,
          projectIds: ["project-alpha"],
        }).pipe(Effect.flip);
        assert.equal(refusal.reason, "source-changed");
      }
      return { projects, threads };
    },
    Effect.provide(Layer.fresh(importLayer)),
    Effect.provideService(References.MinimumLogLevel, "Warn"),
  );
  return Effect.gen(function* () {
    const full = yield* importSource(false);
    const pruned = yield* importSource(true);
    assert.deepEqual(pruned, full);
  });
});
