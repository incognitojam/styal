// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  type LegacyImportPreview,
  type LegacyImportProjectPreview as LegacyImportProjectPreviewType,
  NonNegativeInt,
  PositiveInt,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { inspectLegacyImportPreferences } from "./LegacyImportPreferences.ts";

export interface ReadonlyDatabase {
  readonly exec: (sql: string) => void;
  readonly all: (sql: string, parameters?: ReadonlyArray<string>) => unknown;
  readonly close: () => void;
}

const TableRows = Schema.Array(Schema.Struct({ name: Schema.String }));
const CountRows = Schema.Array(Schema.Struct({ count: NonNegativeInt }));
const SourceProjectRows = Schema.Array(
  Schema.Struct({
    projectId: Schema.String,
    title: Schema.String,
    workspaceRoot: Schema.String,
    faviconPath: Schema.NullOr(Schema.String),
    scriptsJson: Schema.String,
    updatedAt: Schema.String,
  }),
);
const SourceProjectScripts = Schema.Array(Schema.Unknown);
const SourceThreadRows = Schema.Array(
  Schema.Struct({ projectId: Schema.String, threadId: Schema.String }),
);
const DestinationProjectRows = Schema.Array(
  Schema.Struct({
    projectId: Schema.String,
    workspaceRoot: Schema.String,
    deletedAt: Schema.NullOr(Schema.String),
  }),
);
const MigrationVersionRows = Schema.Array(
  Schema.Struct({ schemaVersion: Schema.NullOr(PositiveInt) }),
);
const decodeTableRows = Schema.decodeUnknownSync(TableRows);
const decodeCountRows = Schema.decodeUnknownSync(CountRows);
const decodeSourceProjectRows = Schema.decodeUnknownSync(SourceProjectRows);
const decodeSourceProjectScripts = Schema.decodeUnknownSync(
  Schema.fromJsonString(SourceProjectScripts),
);
const decodeSourceThreadRows = Schema.decodeUnknownSync(SourceThreadRows);
const decodeDestinationProjectRows = Schema.decodeUnknownSync(DestinationProjectRows);
const decodeMigrationVersionRows = Schema.decodeUnknownSync(MigrationVersionRows);

const unavailable = (
  reason: "current-database" | "unsupported-database" | "unreadable-database",
): LegacyImportPreview => ({ status: "unavailable", reason });

function canonicalPath(path: string): string {
  try {
    return NodeFS.realpathSync.native(path);
  } catch {
    return NodePath.resolve(path);
  }
}

export interface LegacyImportDestinationState {
  readonly projectIds: ReadonlySet<string>;
  readonly activeWorkspaceRoots: ReadonlySet<string>;
  readonly threadIds: ReadonlySet<string>;
}

export const emptyLegacyImportDestinationState = (): LegacyImportDestinationState => ({
  projectIds: new Set(),
  activeWorkspaceRoots: new Set(),
  threadIds: new Set(),
});

export function inspectLegacyImportDestinationState(
  database: ReadonlyDatabase,
): LegacyImportDestinationState {
  const tableNames = new Set(
    decodeTableRows(database.all("SELECT name FROM sqlite_master WHERE type = 'table'")).map(
      ({ name }) => name,
    ),
  );
  if (!tableNames.has("projection_projects") || !tableNames.has("projection_threads")) {
    return emptyLegacyImportDestinationState();
  }

  const destinationProjects = decodeDestinationProjectRows(
    database.all(`
      SELECT
        project_id AS projectId,
        workspace_root AS workspaceRoot,
        deleted_at AS deletedAt
      FROM projection_projects
    `),
  );
  const destinationThreads = decodeSourceThreadRows(
    database.all("SELECT project_id AS projectId, thread_id AS threadId FROM projection_threads"),
  );
  const activeWorkspaceRoots = new Set<string>();
  for (const project of destinationProjects) {
    if (project.deletedAt === null) activeWorkspaceRoots.add(project.workspaceRoot);
  }

  return {
    projectIds: new Set(destinationProjects.map((project) => project.projectId)),
    activeWorkspaceRoots,
    threadIds: new Set(destinationThreads.map((thread) => thread.threadId)),
  };
}

export const openReadonlyDatabase = Effect.fn("LegacyImportPreview.openReadonlyDatabase")(
  function* (databasePath: string) {
    if (process.versions.bun !== undefined) {
      const { Database } = yield* Effect.promise(() => import("bun:sqlite"));
      const database = new Database(databasePath, { readonly: true, strict: true });
      return {
        exec: (sql) => database.exec(sql),
        all: (sql, parameters = []) => database.query(sql).all(...parameters),
        close: () => database.close(),
      } satisfies ReadonlyDatabase;
    }

    const { DatabaseSync } = yield* Effect.promise(() => import("node:sqlite"));
    const database = new DatabaseSync(databasePath, { readOnly: true });
    return {
      exec: (sql) => database.exec(sql),
      all: (sql, parameters = []) => database.prepare(sql).all(...parameters),
      close: () => database.close(),
    } satisfies ReadonlyDatabase;
  },
);

export function inspectOpenDatabase(
  database: ReadonlyDatabase,
  destination = emptyLegacyImportDestinationState(),
): LegacyImportPreview {
  database.exec("BEGIN");
  try {
    const tables = decodeTableRows(
      database.all("SELECT name FROM sqlite_master WHERE type = 'table'"),
    );
    const tableNames = new Set(tables.map(({ name }) => name));
    if (!tableNames.has("projection_projects") || !tableNames.has("projection_threads")) {
      database.exec("ROLLBACK");
      return unavailable("unsupported-database");
    }

    let schemaVersion: number | null = null;
    let hasLegacyForkFingerprint = false;
    if (tableNames.has("effect_sql_migrations")) {
      const migrationVersionRows = decodeMigrationVersionRows(
        database.all("SELECT MAX(migration_id) AS schemaVersion FROM effect_sql_migrations"),
      );
      schemaVersion = migrationVersionRows[0]?.schemaVersion ?? null;
      const legacyMigrationRows = decodeCountRows(
        database.all(
          "SELECT COUNT(*) AS count FROM effect_sql_migrations WHERE migration_id = 39 AND name = 'ComposerDrafts'",
        ),
      );
      hasLegacyForkFingerprint = (legacyMigrationRows[0]?.count ?? 0) > 0;
    }

    const projectColumns = new Set(
      decodeTableRows(database.all("PRAGMA table_info(projection_projects)")).map(
        ({ name }) => name,
      ),
    );
    const faviconPathExpression = projectColumns.has("favicon_path")
      ? "projects.favicon_path"
      : "NULL";
    const scriptsJsonExpression = projectColumns.has("scripts_json")
      ? "projects.scripts_json"
      : "'[]'";
    const sourceProjects = decodeSourceProjectRows(
      database.all(`
        SELECT
          projects.project_id AS projectId,
          projects.title,
          projects.workspace_root AS workspaceRoot,
          ${faviconPathExpression} AS faviconPath,
          ${scriptsJsonExpression} AS scriptsJson,
          projects.updated_at AS updatedAt
        FROM projection_projects AS projects
        WHERE projects.deleted_at IS NULL
      `),
    );
    const sourceThreads = decodeSourceThreadRows(
      database.all(`
        SELECT project_id AS projectId, thread_id AS threadId
        FROM projection_threads
        WHERE deleted_at IS NULL
      `),
    );
    const sourceThreadCounts = new Map<string, number>();
    const remainingThreadCounts = new Map<string, number>();
    for (const thread of sourceThreads) {
      sourceThreadCounts.set(thread.projectId, (sourceThreadCounts.get(thread.projectId) ?? 0) + 1);
      if (!destination.threadIds.has(thread.threadId)) {
        remainingThreadCounts.set(
          thread.projectId,
          (remainingThreadCounts.get(thread.projectId) ?? 0) + 1,
        );
      }
    }
    const projects = sourceProjects
      .flatMap((project) => {
        const sourceThreadCount = sourceThreadCounts.get(project.projectId) ?? 0;
        const threadCount = remainingThreadCounts.get(project.projectId) ?? 0;
        const projectAlreadyExists =
          destination.projectIds.has(project.projectId) ||
          destination.activeWorkspaceRoots.has(project.workspaceRoot);
        if (threadCount === 0 && (sourceThreadCount > 0 || projectAlreadyExists)) return [];
        return [
          {
            ...project,
            threadCount,
            scriptCount: decodeSourceProjectScripts(project.scriptsJson).length,
            isExistingProject: projectAlreadyExists,
          },
        ];
      })
      .sort(
        (left, right) =>
          right.threadCount - left.threadCount ||
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.projectId.localeCompare(right.projectId),
      )
      .map(({ updatedAt: _updatedAt, scriptsJson: _scriptsJson, ...project }) => project);
    database.exec("COMMIT");

    return {
      status: "available",
      sourceKind:
        tableNames.has("yngatech_sql_migrations") || hasLegacyForkFingerprint
          ? "t3-code-yngatech"
          : "t3-code",
      projects,
      schemaVersion,
    };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Closing the read-only connection below still releases its snapshot.
    }
    throw error;
  }
}

export const inspectLegacyImportDatabase = Effect.fn(
  "LegacyImportPreview.inspectLegacyImportDatabase",
)(function* ({
  sourceDatabasePath,
  currentDatabasePath,
  sourceSettingsPath,
}: {
  readonly sourceDatabasePath: string;
  readonly currentDatabasePath: string;
  readonly sourceSettingsPath?: string;
}): Effect.fn.Return<LegacyImportPreview, never, never> {
  if (!NodeFS.existsSync(sourceDatabasePath)) {
    return { status: "not-found" };
  }
  if (canonicalPath(sourceDatabasePath) === canonicalPath(currentDatabasePath)) {
    return unavailable("current-database");
  }

  const destination = NodeFS.existsSync(currentDatabasePath)
    ? yield* Effect.acquireUseRelease(
        openReadonlyDatabase(currentDatabasePath),
        (database) => Effect.sync(() => inspectLegacyImportDestinationState(database)),
        (database) => Effect.sync(() => database.close()).pipe(Effect.ignore),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not inspect the destination before previewing legacy data", {
            cause,
          }).pipe(Effect.as(emptyLegacyImportDestinationState())),
        ),
      )
    : emptyLegacyImportDestinationState();

  const databasePreview = yield* Effect.acquireUseRelease(
    openReadonlyDatabase(sourceDatabasePath),
    (database) => Effect.sync(() => inspectOpenDatabase(database, destination)),
    (database) => Effect.sync(() => database.close()).pipe(Effect.ignore),
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not inspect the legacy T3 database", { cause }).pipe(
        Effect.as(unavailable("unreadable-database")),
      ),
    ),
  );
  if (databasePreview.status !== "available" || sourceSettingsPath === undefined) {
    return databasePreview;
  }
  return {
    ...databasePreview,
    preferences: inspectLegacyImportPreferences(sourceSettingsPath),
  };
});

export class LegacyImportPreviewService extends Context.Service<
  LegacyImportPreviewService,
  {
    readonly preview: Effect.Effect<LegacyImportPreview>;
    readonly findProject: (
      projectId: string,
    ) => Effect.Effect<Option.Option<LegacyImportProjectPreviewType>>;
  }
>()("t3/dataImport/LegacyImportPreview/LegacyImportPreviewService") {}

export const makeLegacyImportPreviewService = Effect.fn(
  "LegacyImportPreview.makeLegacyImportPreviewService",
)(function* ({
  sourceDatabasePath,
  currentDatabasePath,
  sourceSettingsPath,
}: {
  readonly sourceDatabasePath: string;
  readonly currentDatabasePath: string;
  readonly sourceSettingsPath?: string;
}) {
  const projectIndex = yield* Ref.make(new Map<string, LegacyImportProjectPreviewType>());
  const preview = inspectLegacyImportDatabase({
    sourceDatabasePath,
    currentDatabasePath,
    ...(sourceSettingsPath === undefined ? {} : { sourceSettingsPath }),
  }).pipe(
    Effect.tap((result) =>
      Ref.set(
        projectIndex,
        new Map(
          result.status === "available"
            ? result.projects.map((project) => [project.projectId, project] as const)
            : [],
        ),
      ),
    ),
  );
  const findProject = Effect.fn("LegacyImportPreview.findProject")(function* (projectId: string) {
    const projects = yield* Ref.get(projectIndex);
    return Option.fromUndefinedOr(projects.get(projectId));
  });

  return LegacyImportPreviewService.of({
    preview,
    findProject,
  });
});

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  return yield* makeLegacyImportPreviewService({
    sourceDatabasePath: NodePath.join(NodeOS.homedir(), ".t3", "userdata", "state.sqlite"),
    sourceSettingsPath: NodePath.join(NodeOS.homedir(), ".t3", "userdata", "settings.json"),
    currentDatabasePath: config.dbPath,
  });
});

export const layer = Layer.effect(LegacyImportPreviewService, make);
