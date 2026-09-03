// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  inspectLegacyImportDatabase,
  makeLegacyImportPreviewService,
  sanitizeLegacyResumeCursor,
} from "./LegacyImportPreview.ts";

function makeTempDirectory(): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-legacy-import-preview-"));
}

function createProjectionDatabase(
  databasePath: string,
  options: {
    readonly forkTable?: boolean;
    readonly legacyForkMigration?: boolean;
    readonly schemaVersion?: number;
  } = {},
): void {
  const database = new NodeSqlite.DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      favicon_path TEXT,
      scripts_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE effect_sql_migrations (
      migration_id INTEGER NOT NULL,
      name TEXT NOT NULL
    );
    INSERT INTO projection_projects VALUES ('project-active', 'Active project', '/work/active', 'assets/active.svg', '[{}, {}]', '2026-02-01T00:00:00Z', NULL);
    INSERT INTO projection_projects VALUES ('project-empty', 'Empty project', '/work/empty', NULL, '[]', '2026-03-01T00:00:00Z', NULL);
    INSERT INTO projection_projects VALUES ('project-deleted', 'Deleted project', '/work/deleted', NULL, '[]', '2025-12-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO projection_threads VALUES ('thread-one', 'project-active', NULL);
    INSERT INTO projection_threads VALUES ('thread-two', 'project-active', NULL);
    INSERT INTO projection_threads VALUES ('thread-deleted', 'project-active', '2026-01-01T00:00:00Z');
  `);
  database
    .prepare("INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)")
    .run(
      options.schemaVersion ?? 43,
      options.legacyForkMigration ? "ComposerDrafts" : "ProjectionThreadsUnsettledAt",
    );
  if (options.forkTable) {
    database.exec(`
      CREATE TABLE yngatech_sql_migrations (
        migration_id INTEGER NOT NULL,
        name TEXT NOT NULL
      );
    `);
  }
  database.close();
}

function addProviderContinuation(
  databasePath: string,
  threadId: string,
  providerThreadId: string,
): void {
  const database = new NodeSqlite.DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS provider_session_runtime (
      thread_id TEXT PRIMARY KEY,
      provider_name TEXT NOT NULL,
      provider_instance_id TEXT,
      adapter_key TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      resume_cursor_json TEXT,
      runtime_payload_json TEXT
    )
  `);
  database
    .prepare(
      `INSERT INTO provider_session_runtime VALUES (?, 'codex', 'codex', 'codex', 'full-access', 'stopped', '2026-02-01T00:00:00Z', ?, NULL)`,
    )
    .run(threadId, JSON.stringify({ threadId: providerThreadId }));
  database.close();
}

it("keeps only known provider continuation fields", () => {
  assert.deepStrictEqual(
    sanitizeLegacyResumeCursor("claudeAgent", {
      threadId: "thread-import",
      resume: "provider-session",
      resumeSessionAt: "assistant-message",
      turnCount: 4,
      accessToken: "must-not-cross-import",
    }),
    {
      threadId: "thread-import",
      resume: "provider-session",
      resumeSessionAt: "assistant-message",
      turnCount: 4,
    },
  );
  assert.deepStrictEqual(
    sanitizeLegacyResumeCursor("opencode", {
      schemaVersion: 1,
      sessionId: "provider-session",
      credential: "must-not-cross-import",
    }),
    { schemaVersion: 1, sessionId: "provider-session" },
  );
  assert.isNull(
    sanitizeLegacyResumeCursor("custom-provider", {
      sessionId: "opaque-session",
    }),
  );
});

it.effect("returns not-found when the default T3 database does not exist", () => {
  const tempDirectory = makeTempDirectory();
  return inspectLegacyImportDatabase({
    sourceDatabasePath: NodePath.join(tempDirectory, "missing.sqlite"),
    currentDatabasePath: NodePath.join(tempDirectory, "current.sqlite"),
  }).pipe(
    Effect.tap((preview) =>
      Effect.sync(() => assert.deepStrictEqual(preview, { status: "not-found" })),
    ),
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(tempDirectory, { recursive: true, force: true })),
    ),
  );
});

it.effect("does not offer the database currently used by the server", () => {
  const tempDirectory = makeTempDirectory();
  const databasePath = NodePath.join(tempDirectory, "state.sqlite");
  createProjectionDatabase(databasePath);
  return inspectLegacyImportDatabase({
    sourceDatabasePath: databasePath,
    currentDatabasePath: databasePath,
  }).pipe(
    Effect.tap((preview) =>
      Effect.sync(() =>
        assert.deepStrictEqual(preview, {
          status: "unavailable",
          reason: "current-database",
        }),
      ),
    ),
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(tempDirectory, { recursive: true, force: true })),
    ),
  );
});

it.effect("previews active projects and threads from T3 Code", () => {
  const tempDirectory = makeTempDirectory();
  const sourceDatabasePath = NodePath.join(tempDirectory, "legacy.sqlite");
  createProjectionDatabase(sourceDatabasePath, { schemaVersion: 43 });
  const modifiedAtBeforePreview = NodeFS.statSync(sourceDatabasePath, { bigint: true }).mtimeNs;
  return inspectLegacyImportDatabase({
    sourceDatabasePath,
    currentDatabasePath: NodePath.join(tempDirectory, "current.sqlite"),
  }).pipe(
    Effect.tap((preview) =>
      Effect.sync(() => {
        assert.deepStrictEqual(preview, {
          status: "available",
          sourceKind: "t3-code",
          projects: [
            {
              projectId: "project-active",
              title: "Active project",
              workspaceRoot: "/work/active",
              faviconPath: "assets/active.svg",
              threadCount: 2,
              contextRepairCount: 0,
              scriptCount: 2,
              isExistingProject: false,
            },
            {
              projectId: "project-empty",
              title: "Empty project",
              workspaceRoot: "/work/empty",
              faviconPath: null,
              threadCount: 0,
              contextRepairCount: 0,
              scriptCount: 0,
              isExistingProject: false,
            },
          ],
          schemaVersion: 43,
        });
        assert.strictEqual(
          NodeFS.statSync(sourceDatabasePath, { bigint: true }).mtimeNs,
          modifiedAtBeforePreview,
        );
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(tempDirectory, { recursive: true, force: true })),
    ),
  );
});

it.effect("previews only projects and threads that are not already in the destination", () => {
  const tempDirectory = makeTempDirectory();
  const sourceDatabasePath = NodePath.join(tempDirectory, "legacy.sqlite");
  const currentDatabasePath = NodePath.join(tempDirectory, "current.sqlite");
  createProjectionDatabase(sourceDatabasePath);
  createProjectionDatabase(currentDatabasePath);
  const currentDatabase = new NodeSqlite.DatabaseSync(currentDatabasePath);
  currentDatabase.exec(`
    UPDATE projection_threads
    SET deleted_at = '2026-04-01T00:00:00Z'
    WHERE thread_id = 'thread-one';
    DELETE FROM projection_threads WHERE thread_id = 'thread-two';
  `);
  currentDatabase.close();

  return inspectLegacyImportDatabase({
    sourceDatabasePath,
    currentDatabasePath,
  }).pipe(
    Effect.tap((preview) =>
      Effect.sync(() => {
        assert.strictEqual(preview.status, "available");
        if (preview.status !== "available") return;
        assert.deepStrictEqual(preview.projects, [
          {
            projectId: "project-active",
            title: "Active project",
            workspaceRoot: "/work/active",
            faviconPath: "assets/active.svg",
            threadCount: 1,
            contextRepairCount: 0,
            scriptCount: 2,
            isExistingProject: true,
          },
        ]);
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(tempDirectory, { recursive: true, force: true })),
    ),
  );
});

it.effect(
  "offers context repair when an imported thread started a different provider session",
  () => {
    const tempDirectory = makeTempDirectory();
    const sourceDatabasePath = NodePath.join(tempDirectory, "legacy.sqlite");
    const currentDatabasePath = NodePath.join(tempDirectory, "current.sqlite");
    createProjectionDatabase(sourceDatabasePath);
    createProjectionDatabase(currentDatabasePath);
    addProviderContinuation(sourceDatabasePath, "thread-one", "provider-thread-original");
    addProviderContinuation(currentDatabasePath, "thread-one", "provider-thread-replacement");

    return inspectLegacyImportDatabase({
      sourceDatabasePath,
      currentDatabasePath,
    }).pipe(
      Effect.tap((preview) =>
        Effect.sync(() => {
          assert.strictEqual(preview.status, "available");
          if (preview.status !== "available") return;
          assert.deepStrictEqual(preview.projects, [
            {
              projectId: "project-active",
              title: "Active project",
              workspaceRoot: "/work/active",
              faviconPath: "assets/active.svg",
              threadCount: 0,
              contextRepairCount: 1,
              scriptCount: 2,
              isExistingProject: true,
            },
          ]);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(tempDirectory, { recursive: true, force: true })),
      ),
    );
  },
);

it.effect("previews only the preferences that can be imported", () => {
  const tempDirectory = makeTempDirectory();
  const sourceDatabasePath = NodePath.join(tempDirectory, "legacy.sqlite");
  const sourceSettingsPath = NodePath.join(tempDirectory, "settings.json");
  createProjectionDatabase(sourceDatabasePath);
  NodeFS.writeFileSync(
    sourceSettingsPath,
    JSON.stringify({
      enableProviderUpdateChecks: false,
      defaultThreadEnvMode: "local",
      addProjectBaseDirectory: "/workspace/projects",
      sourceControlWritingStyle: {
        mode: "custom",
        customInstructions: "Use concise change descriptions.",
        followChangeRequestTemplates: false,
      },
      providers: { codex: { binaryPath: "/private/provider-binary" } },
    }),
  );

  return inspectLegacyImportDatabase({
    sourceDatabasePath,
    sourceSettingsPath,
    currentDatabasePath: NodePath.join(tempDirectory, "current.sqlite"),
  }).pipe(
    Effect.tap((preview) =>
      Effect.sync(() => {
        assert.strictEqual(preview.status, "available");
        if (preview.status !== "available") return;
        assert.strictEqual(preview.preferences?.status, "available");
        if (preview.preferences?.status !== "available") return;
        assert.isFalse(preview.preferences.values.enableProviderUpdateChecks);
        assert.strictEqual(preview.preferences.values.defaultThreadEnvMode, "local");
        assert.strictEqual(
          preview.preferences.values.addProjectBaseDirectory,
          "/workspace/projects",
        );
        assert.deepStrictEqual(preview.preferences.values.sourceControlWritingStyle, {
          mode: "custom",
          customInstructions: "Use concise change descriptions.",
          followChangeRequestTemplates: false,
        });
        assert.isFalse("providers" in preview.preferences.values);
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(tempDirectory, { recursive: true, force: true })),
    ),
  );
});

it.effect("keeps projects available when the preference file is unreadable", () => {
  const tempDirectory = makeTempDirectory();
  const sourceDatabasePath = NodePath.join(tempDirectory, "legacy.sqlite");
  const sourceSettingsPath = NodePath.join(tempDirectory, "settings.json");
  createProjectionDatabase(sourceDatabasePath);
  NodeFS.writeFileSync(sourceSettingsPath, "{not-json");

  return inspectLegacyImportDatabase({
    sourceDatabasePath,
    sourceSettingsPath,
    currentDatabasePath: NodePath.join(tempDirectory, "current.sqlite"),
  }).pipe(
    Effect.tap((preview) =>
      Effect.sync(() => {
        assert.strictEqual(preview.status, "available");
        if (preview.status !== "available") return;
        assert.lengthOf(preview.projects, 2);
        assert.deepStrictEqual(preview.preferences, { status: "unreadable" });
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(tempDirectory, { recursive: true, force: true })),
    ),
  );
});

it.effect("indexes previewed projects for legacy favicon authorization", () => {
  const tempDirectory = makeTempDirectory();
  const sourceDatabasePath = NodePath.join(tempDirectory, "legacy.sqlite");
  createProjectionDatabase(sourceDatabasePath);
  return Effect.gen(function* () {
    const service = yield* makeLegacyImportPreviewService({
      sourceDatabasePath,
      currentDatabasePath: NodePath.join(tempDirectory, "current.sqlite"),
    });
    yield* service.preview;

    assert.deepStrictEqual(Option.getOrNull(yield* service.findProject("project-active")), {
      projectId: "project-active",
      title: "Active project",
      workspaceRoot: "/work/active",
      faviconPath: "assets/active.svg",
      threadCount: 2,
      contextRepairCount: 0,
      scriptCount: 2,
      isExistingProject: false,
    });
    assert.isNull(Option.getOrNull(yield* service.findProject("project-deleted")));
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(tempDirectory, { recursive: true, force: true })),
    ),
  );
});

it.effect("reads a live WAL database without copying or quiescing it", () => {
  const tempDirectory = makeTempDirectory();
  const sourceDatabasePath = NodePath.join(tempDirectory, "legacy.sqlite");
  const liveDatabase = new NodeSqlite.DatabaseSync(sourceDatabasePath);
  liveDatabase.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      deleted_at TEXT
    );
    INSERT INTO projection_projects VALUES ('project-live', 'Live project', '/work/live', '2026-01-01T00:00:00Z', NULL);
    INSERT INTO projection_threads VALUES ('thread-live', 'project-live', NULL);
  `);

  return inspectLegacyImportDatabase({
    sourceDatabasePath,
    currentDatabasePath: NodePath.join(tempDirectory, "current.sqlite"),
  }).pipe(
    Effect.tap((preview) =>
      Effect.sync(() =>
        assert.deepStrictEqual(preview, {
          status: "available",
          sourceKind: "t3-code",
          projects: [
            {
              projectId: "project-live",
              title: "Live project",
              workspaceRoot: "/work/live",
              faviconPath: null,
              threadCount: 1,
              contextRepairCount: 0,
              scriptCount: 0,
              isExistingProject: false,
            },
          ],
          schemaVersion: null,
        }),
      ),
    ),
    Effect.ensuring(Effect.sync(() => liveDatabase.close())),
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(tempDirectory, { recursive: true, force: true })),
    ),
  );
});

it.effect("recognizes the yngatech fork migration table", () => {
  const tempDirectory = makeTempDirectory();
  const sourceDatabasePath = NodePath.join(tempDirectory, "legacy.sqlite");
  createProjectionDatabase(sourceDatabasePath, { forkTable: true });
  return inspectLegacyImportDatabase({
    sourceDatabasePath,
    currentDatabasePath: NodePath.join(tempDirectory, "current.sqlite"),
  }).pipe(
    Effect.tap((preview) =>
      Effect.sync(() => {
        assert.strictEqual(preview.status, "available");
        if (preview.status === "available") {
          assert.strictEqual(preview.sourceKind, "t3-code-yngatech");
        }
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(tempDirectory, { recursive: true, force: true })),
    ),
  );
});

it.effect("recognizes the legacy yngatech migration fingerprint", () => {
  const tempDirectory = makeTempDirectory();
  const sourceDatabasePath = NodePath.join(tempDirectory, "legacy.sqlite");
  createProjectionDatabase(sourceDatabasePath, {
    legacyForkMigration: true,
    schemaVersion: 39,
  });
  return inspectLegacyImportDatabase({
    sourceDatabasePath,
    currentDatabasePath: NodePath.join(tempDirectory, "current.sqlite"),
  }).pipe(
    Effect.tap((preview) =>
      Effect.sync(() => {
        assert.strictEqual(preview.status, "available");
        if (preview.status === "available") {
          assert.strictEqual(preview.sourceKind, "t3-code-yngatech");
        }
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(tempDirectory, { recursive: true, force: true })),
    ),
  );
});

it.effect("reports databases without orchestration projections as unsupported", () => {
  const tempDirectory = makeTempDirectory();
  const sourceDatabasePath = NodePath.join(tempDirectory, "legacy.sqlite");
  const database = new NodeSqlite.DatabaseSync(sourceDatabasePath);
  database.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
  database.close();

  return inspectLegacyImportDatabase({
    sourceDatabasePath,
    currentDatabasePath: NodePath.join(tempDirectory, "current.sqlite"),
  }).pipe(
    Effect.tap((preview) =>
      Effect.sync(() =>
        assert.deepStrictEqual(preview, {
          status: "unavailable",
          reason: "unsupported-database",
        }),
      ),
    ),
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(tempDirectory, { recursive: true, force: true })),
    ),
  );
});

it.effect("reports malformed SQLite files as unreadable", () => {
  const tempDirectory = makeTempDirectory();
  const sourceDatabasePath = NodePath.join(tempDirectory, "legacy.sqlite");
  NodeFS.writeFileSync(sourceDatabasePath, "not a sqlite database");

  return inspectLegacyImportDatabase({
    sourceDatabasePath,
    currentDatabasePath: NodePath.join(tempDirectory, "current.sqlite"),
  }).pipe(
    Effect.tap((preview) =>
      Effect.sync(() =>
        assert.deepStrictEqual(preview, {
          status: "unavailable",
          reason: "unreadable-database",
        }),
      ),
    ),
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(tempDirectory, { recursive: true, force: true })),
    ),
  );
});
