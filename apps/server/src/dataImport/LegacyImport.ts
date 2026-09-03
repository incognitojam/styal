// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  defaultInstanceIdForDriver,
  EventId,
  LegacyImportError,
  type LegacyImportProjectPreview,
  type LegacyImportRequest,
  type LegacyImportResult,
  type LegacyImportSourceKind,
  NonNegativeInt,
  OrchestrationAggregateKind,
  OrchestrationEvent,
  OrchestrationEventType,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  RuntimeMode,
  ThreadId,
  CommandId,
  IsoDateTime,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { attachmentRelativePath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import {
  OrchestrationEngineService,
  type HistoricalProviderContinuation,
} from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  emptyLegacyImportDestinationState,
  inspectLegacyImportDestinationState,
  inspectOpenDatabase,
  legacyContinuationKey,
  openReadonlyDatabase,
  sanitizeLegacyResumeCursor,
  type LegacyImportDestinationState,
  type ReadonlyDatabase,
} from "./LegacyImportPreview.ts";
import { readLegacyImportPreferences } from "./LegacyImportPreferences.ts";

const SourceThreadRows = Schema.Array(Schema.Struct({ threadId: ThreadId }));
const SourceTableRows = Schema.Array(Schema.Struct({ name: Schema.String }));
const SourceEventRows = Schema.Array(
  Schema.Struct({
    sequence: NonNegativeInt,
    eventId: EventId,
    type: OrchestrationEventType,
    aggregateKind: OrchestrationAggregateKind,
    aggregateId: Schema.Union([ProjectId, ThreadId]),
    occurredAt: IsoDateTime,
    commandId: Schema.NullOr(CommandId),
    causationEventId: Schema.NullOr(EventId),
    correlationId: Schema.NullOr(CommandId),
    payloadJson: Schema.String,
    metadataJson: Schema.String,
  }),
);
const SourceRuntimeRows = Schema.Array(
  Schema.Struct({
    threadId: ThreadId,
    provider: ProviderDriverKind,
    providerInstanceId: Schema.NullOr(ProviderInstanceId),
    runtimeMode: RuntimeMode,
    lastSeenAt: IsoDateTime,
    resumeCursorJson: Schema.String,
  }),
);
const decodeSourceThreadRows = Schema.decodeUnknownSync(SourceThreadRows);
const decodeSourceTableRows = Schema.decodeUnknownSync(SourceTableRows);
const decodeSourceEventRows = Schema.decodeUnknownSync(SourceEventRows);
const decodeSourceRuntimeRows = Schema.decodeUnknownSync(SourceRuntimeRows);
const decodeUnknownJsonString = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeOrchestrationEvent = Schema.decodeUnknownSync(OrchestrationEvent);
const decodeProjectId = Schema.decodeUnknownSync(ProjectId);
const isLegacyImportError = Schema.is(LegacyImportError);

interface LegacySourceProjectPlan {
  readonly projectId: ProjectId;
  readonly project: LegacyImportProjectPreview;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly repairThreadIds: ReadonlyArray<ThreadId>;
  readonly continuations: ReadonlyMap<ThreadId, HistoricalProviderContinuation>;
  readonly events: ReadonlyArray<OrchestrationEvent>;
}

interface LegacySourceSnapshot {
  readonly sourceKind: LegacyImportSourceKind;
  readonly projects: ReadonlyArray<LegacySourceProjectPlan>;
}

const OMITTED_EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.session-stop-requested",
  "thread.session-set",
]);
const OMITTED_ACTIVITY_KINDS = new Set([
  "approval.requested",
  "approval.resolved",
  "context-window.updated",
  "provider.approval.respond.failed",
  "user-input.requested",
  "user-input.resolved",
]);

function sourceFailure(reason: LegacyImportError["reason"], detail: string): LegacyImportError {
  return new LegacyImportError({ reason, detail });
}

function canonicalPath(path: string): string {
  try {
    return NodeFS.realpathSync.native(path);
  } catch {
    return NodePath.resolve(path);
  }
}

function readProjectEvents(
  database: ReadonlyDatabase,
  projectId: ProjectId,
  threadIds: ReadonlyArray<ThreadId>,
): ReadonlyArray<OrchestrationEvent> {
  const threadFilter =
    threadIds.length === 0
      ? ""
      : `
          OR (
            events.aggregate_kind = 'thread'
            AND events.stream_id IN (${threadIds.map(() => "?").join(", ")})
          )
        `;
  const rows = decodeSourceEventRows(
    database.all(
      `
        SELECT
          events.sequence,
          events.event_id AS eventId,
          events.event_type AS type,
          events.aggregate_kind AS aggregateKind,
          events.stream_id AS aggregateId,
          events.occurred_at AS occurredAt,
          events.command_id AS commandId,
          events.causation_event_id AS causationEventId,
          events.correlation_id AS correlationId,
          events.payload_json AS payloadJson,
          events.metadata_json AS metadataJson
        FROM orchestration_events AS events
        WHERE
          (events.aggregate_kind = 'project' AND events.stream_id = ?)
          ${threadFilter}
        ORDER BY events.sequence ASC
      `,
      [projectId, ...threadIds],
    ),
  );

  return rows.map((row) =>
    decodeOrchestrationEvent({
      sequence: row.sequence,
      eventId: row.eventId,
      type: row.type,
      aggregateKind: row.aggregateKind,
      aggregateId: row.aggregateId,
      occurredAt: row.occurredAt,
      commandId: row.commandId,
      causationEventId: row.causationEventId,
      correlationId: row.correlationId,
      payload: JSON.parse(row.payloadJson),
      metadata: JSON.parse(row.metadataJson),
    }),
  );
}

function readSourceContinuations(
  database: ReadonlyDatabase,
  threadIds: ReadonlyArray<ThreadId>,
): ReadonlyMap<ThreadId, HistoricalProviderContinuation> {
  if (threadIds.length === 0) return new Map();
  const tables = new Set(
    decodeSourceTableRows(database.all("SELECT name FROM sqlite_master WHERE type = 'table'")).map(
      ({ name }) => name,
    ),
  );
  if (!tables.has("provider_session_runtime")) return new Map();
  const columns = new Set(
    decodeSourceTableRows(database.all("PRAGMA table_info(provider_session_runtime)")).map(
      ({ name }) => name,
    ),
  );
  const providerInstanceIdExpression = columns.has("provider_instance_id")
    ? "provider_instance_id"
    : "NULL";
  const runtimeModeExpression = columns.has("runtime_mode") ? "runtime_mode" : "'full-access'";
  const rows = decodeSourceRuntimeRows(
    database.all(
      `
        SELECT
          thread_id AS threadId,
          provider_name AS provider,
          ${providerInstanceIdExpression} AS providerInstanceId,
          ${runtimeModeExpression} AS runtimeMode,
          last_seen_at AS lastSeenAt,
          resume_cursor_json AS resumeCursorJson
        FROM provider_session_runtime
        WHERE
          resume_cursor_json IS NOT NULL
          AND thread_id IN (${threadIds.map(() => "?").join(", ")})
      `,
      threadIds,
    ),
  );
  return new Map(
    rows.flatMap((row) => {
      try {
        const resumeCursor = sanitizeLegacyResumeCursor(
          row.provider,
          decodeUnknownJsonString(row.resumeCursorJson),
        );
        if (resumeCursor === null) return [];
        return [
          [
            row.threadId,
            {
              threadId: row.threadId,
              provider: row.provider,
              providerInstanceId:
                row.providerInstanceId ?? defaultInstanceIdForDriver(row.provider),
              runtimeMode: row.runtimeMode,
              lastSeenAt: row.lastSeenAt,
              resumeCursor,
            },
          ] as const,
        ];
      } catch {
        return [];
      }
    }),
  );
}

function sanitizeHistoricalEvent(event: OrchestrationEvent): OrchestrationEvent | null {
  if (OMITTED_EVENT_TYPES.has(event.type)) {
    return null;
  }
  if (
    event.type === "thread.activity-appended" &&
    OMITTED_ACTIVITY_KINDS.has(event.payload.activity.kind)
  ) {
    return null;
  }
  if (event.type === "thread.meta-updated") {
    const {
      regenerateTitle: _regenerateTitle,
      previousTitle: _previousTitle,
      titleRegeneration: _titleRegeneration,
      ...payload
    } = event.payload;
    return { ...event, payload };
  }
  return event;
}

function mergeMessageEvents(
  previous: Extract<OrchestrationEvent, { readonly type: "thread.message-sent" }> | undefined,
  current: Extract<OrchestrationEvent, { readonly type: "thread.message-sent" }>,
): Extract<OrchestrationEvent, { readonly type: "thread.message-sent" }> {
  if (previous === undefined) {
    return { ...current, payload: { ...current.payload, streaming: false } };
  }

  const text = current.payload.streaming
    ? `${previous.payload.text}${current.payload.text}`
    : current.payload.text.length === 0
      ? previous.payload.text
      : current.payload.text;
  const attachments = current.payload.attachments ?? previous.payload.attachments;
  return {
    ...current,
    payload: {
      ...current.payload,
      text,
      streaming: false,
      createdAt: previous.payload.createdAt,
      ...(attachments === undefined ? {} : { attachments }),
    },
  };
}

function compactHistoricalEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): ReadonlyArray<OrchestrationEvent> {
  const messages = new Map<
    string,
    {
      readonly index: number;
      readonly event: Extract<OrchestrationEvent, { readonly type: "thread.message-sent" }>;
    }
  >();
  const activities = new Map<
    string,
    { readonly index: number; readonly event: OrchestrationEvent }
  >();

  for (const [index, event] of events.entries()) {
    if (event.type === "thread.message-sent") {
      messages.set(event.payload.messageId, {
        index,
        event: mergeMessageEvents(messages.get(event.payload.messageId)?.event, event),
      });
      continue;
    }
    if (event.type === "thread.activity-appended") {
      activities.set(event.payload.activity.id, { index, event });
    }
  }

  return events.flatMap((event, index) => {
    if (event.type === "thread.message-sent") {
      const message = messages.get(event.payload.messageId);
      return message?.index === index ? [message.event] : [];
    }
    if (event.type === "thread.activity-appended") {
      const activity = activities.get(event.payload.activity.id);
      return activity?.index === index ? [activity.event] : [];
    }
    return [event];
  });
}

function inspectSelectedProjects(
  database: ReadonlyDatabase,
  selectedProjectIds: ReadonlySet<string>,
  destination: LegacyImportDestinationState,
): LegacySourceSnapshot {
  const preview = inspectOpenDatabase(database);
  if (preview.status !== "available") {
    const reason =
      preview.status === "not-found" || preview.reason === "current-database"
        ? "source-changed"
        : preview.reason === "unsupported-database"
          ? "unsupported-source"
          : "read-failed";
    throw sourceFailure(reason, "The T3 Code data is no longer available to import.");
  }

  const selectedProjects = preview.projects.filter((project) =>
    selectedProjectIds.has(project.projectId),
  );
  if (selectedProjects.length !== selectedProjectIds.size) {
    throw sourceFailure(
      "source-changed",
      "The available projects changed. Rescan before importing.",
    );
  }

  const tableRows = database.all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_events'",
  ) as ReadonlyArray<unknown>;
  if (tableRows.length === 0) {
    throw sourceFailure(
      "unsupported-source",
      "This T3 Code installation does not contain importable thread history.",
    );
  }

  database.exec("BEGIN");
  try {
    const projects = selectedProjects.map((project) => {
      const projectId = decodeProjectId(project.projectId);
      const allThreadIds = decodeSourceThreadRows(
        database.all(
          `
            SELECT thread_id AS threadId
            FROM projection_threads
            WHERE project_id = ? AND deleted_at IS NULL
            ORDER BY thread_id ASC
          `,
          [projectId],
        ),
      ).map(({ threadId }) => threadId);
      const continuations = readSourceContinuations(database, allThreadIds);
      const threadIds = allThreadIds.filter((threadId) => !destination.threadIds.has(threadId));
      const repairThreadIds = allThreadIds.filter((threadId) => {
        if (!destination.threadIds.has(threadId)) return false;
        const continuation = continuations.get(threadId);
        return (
          continuation !== undefined &&
          destination.continuationKeys.get(threadId) !==
            legacyContinuationKey({
              providerName: continuation.provider,
              providerInstanceId: continuation.providerInstanceId,
              resumeCursor: continuation.resumeCursor,
            })
        );
      });
      const events = compactHistoricalEvents(
        readProjectEvents(database, projectId, threadIds)
          .map(sanitizeHistoricalEvent)
          .filter((event): event is OrchestrationEvent => event !== null),
      );
      if (!events.some((event) => event.type === "project.created")) {
        throw sourceFailure(
          "unsupported-source",
          `The history for ${project.title} is incomplete and cannot be imported.`,
        );
      }
      if (
        threadIds.some(
          (threadId) =>
            !events.some(
              (event) => event.type === "thread.created" && event.payload.threadId === threadId,
            ),
        )
      ) {
        throw sourceFailure(
          "unsupported-source",
          `The thread history for ${project.title} is incomplete and cannot be imported.`,
        );
      }
      return {
        projectId,
        project,
        threadIds,
        repairThreadIds,
        continuations,
        events,
      } satisfies LegacySourceProjectPlan;
    });
    database.exec("COMMIT");
    return { sourceKind: preview.sourceKind, projects };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Closing the read-only connection releases the snapshot if rollback fails.
    }
    throw error;
  }
}

export const readLegacySourceSnapshot = Effect.fn("LegacyImport.readLegacySourceSnapshot")(
  function* ({
    sourceDatabasePath,
    currentDatabasePath,
    projectIds,
    destination = emptyLegacyImportDestinationState(),
  }: {
    readonly sourceDatabasePath: string;
    readonly currentDatabasePath: string;
    readonly projectIds: ReadonlyArray<string>;
    readonly destination?: LegacyImportDestinationState;
  }): Effect.fn.Return<LegacySourceSnapshot, LegacyImportError, never> {
    if (!NodeFS.existsSync(sourceDatabasePath)) {
      return yield* sourceFailure("source-not-found", "No T3 Code data was found on this server.");
    }
    if (canonicalPath(sourceDatabasePath) === canonicalPath(currentDatabasePath)) {
      return yield* sourceFailure(
        "source-changed",
        "The detected T3 Code data is already this environment's live database.",
      );
    }

    return yield* Effect.acquireUseRelease(
      openReadonlyDatabase(sourceDatabasePath),
      (database) =>
        Effect.try({
          try: () => inspectSelectedProjects(database, new Set(projectIds), destination),
          catch: (error) =>
            isLegacyImportError(error)
              ? error
              : sourceFailure("read-failed", "The T3 Code data could not be read."),
        }),
      (database) => Effect.sync(() => database.close()).pipe(Effect.ignore),
    ).pipe(
      Effect.catchDefect(() =>
        Effect.fail(sourceFailure("read-failed", "The T3 Code data could not be read.")),
      ),
    );
  },
);

function withoutSequence(event: OrchestrationEvent): Omit<OrchestrationEvent, "sequence"> {
  const { sequence: _sequence, ...eventBase } = event;
  return eventBase;
}

function prepareThreadEvents(input: {
  readonly plan: LegacySourceProjectPlan;
  readonly targetProjectId: ProjectId;
  readonly threadId: ThreadId;
  readonly includeProject: boolean;
  readonly unavailableAttachmentPaths: ReadonlySet<string>;
}): ReadonlyArray<Omit<OrchestrationEvent, "sequence">> {
  return input.plan.events
    .filter((event) => {
      if (event.aggregateKind === "project") return input.includeProject;
      return event.aggregateId === input.threadId;
    })
    .map((event) => {
      if (event.type === "thread.message-sent" && event.payload.attachments !== undefined) {
        const attachments = event.payload.attachments.filter((attachment) => {
          const relativePath = attachmentRelativePath(attachment);
          return relativePath === null || !input.unavailableAttachmentPaths.has(relativePath);
        });
        if (attachments.length !== event.payload.attachments.length) {
          return withoutSequence({
            ...event,
            payload: { ...event.payload, attachments },
          });
        }
      }
      if (event.type !== "thread.created" || event.payload.projectId === input.targetProjectId) {
        return withoutSequence(event);
      }
      return withoutSequence({
        ...event,
        payload: { ...event.payload, projectId: input.targetProjectId },
      });
    });
}

function prepareProjectEvents(
  plan: LegacySourceProjectPlan,
): ReadonlyArray<Omit<OrchestrationEvent, "sequence">> {
  return plan.events.filter((event) => event.aggregateKind === "project").map(withoutSequence);
}

const copyThreadAttachments = Effect.fn("LegacyImport.copyThreadAttachments")(function* (input: {
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly threadId: ThreadId;
  readonly sourceAttachmentsDir: string;
  readonly targetAttachmentsDir: string;
}): Effect.fn.Return<ReadonlySet<string>, LegacyImportError> {
  const relativePaths = new Set<string>();
  for (const event of input.events) {
    if (event.type !== "thread.message-sent" || event.payload.threadId !== input.threadId) {
      continue;
    }
    for (const attachment of event.payload.attachments ?? []) {
      const relativePath = attachmentRelativePath(attachment);
      if (relativePath !== null) relativePaths.add(relativePath);
    }
  }
  if (relativePaths.size === 0) return new Set<string>();

  const stagingDirectory = NodePath.join(
    input.targetAttachmentsDir,
    ".legacy-import",
    NodeCrypto.randomUUID(),
  );
  return yield* Effect.tryPromise({
    try: async () => {
      await NodeFS.promises.mkdir(stagingDirectory, { recursive: true });
      const pendingMoves: Array<{ readonly stagedPath: string; readonly targetPath: string }> = [];
      const unavailableRelativePaths = new Set<string>();

      for (const relativePath of relativePaths) {
        const sourcePath = resolveAttachmentRelativePath({
          attachmentsDir: input.sourceAttachmentsDir,
          relativePath,
        });
        const targetPath = resolveAttachmentRelativePath({
          attachmentsDir: input.targetAttachmentsDir,
          relativePath,
        });
        const stagedPath = resolveAttachmentRelativePath({
          attachmentsDir: stagingDirectory,
          relativePath,
        });
        if (sourcePath === null || targetPath === null || stagedPath === null) {
          throw sourceFailure("read-failed", "A thread attachment has an invalid path.");
        }

        try {
          const targetStat = await NodeFS.promises.stat(targetPath);
          if (!targetStat.isFile()) {
            throw sourceFailure("read-failed", "A thread attachment could not be imported.");
          }
          continue;
        } catch (error) {
          if (isLegacyImportError(error)) throw error;
        }

        let sourceStat: NodeFS.Stats;
        try {
          sourceStat = await NodeFS.promises.stat(sourcePath);
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            unavailableRelativePaths.add(relativePath);
            continue;
          }
          throw error;
        }
        if (!sourceStat.isFile()) {
          unavailableRelativePaths.add(relativePath);
          continue;
        }

        await NodeFS.promises.copyFile(sourcePath, stagedPath, NodeFS.constants.COPYFILE_EXCL);
        const stagedStat = await NodeFS.promises.stat(stagedPath);
        if (!stagedStat.isFile() || stagedStat.size !== sourceStat.size) {
          throw sourceFailure("read-failed", "A thread attachment could not be copied safely.");
        }
        pendingMoves.push({ stagedPath, targetPath });
      }

      await NodeFS.promises.mkdir(input.targetAttachmentsDir, { recursive: true });
      for (const move of pendingMoves) {
        try {
          await NodeFS.promises.rename(move.stagedPath, move.targetPath);
        } catch {
          try {
            const targetStat = await NodeFS.promises.stat(move.targetPath);
            if (targetStat.isFile()) continue;
          } catch {
            // The original rename failure is reported below.
          }
          throw sourceFailure("read-failed", "A thread attachment could not be imported.");
        }
      }

      return unavailableRelativePaths;
    },
    catch: (error) =>
      isLegacyImportError(error)
        ? error
        : sourceFailure("read-failed", "A thread attachment could not be imported."),
  }).pipe(
    Effect.ensuring(
      Effect.promise(() =>
        NodeFS.promises.rm(stagingDirectory, { recursive: true, force: true }),
      ).pipe(Effect.ignore),
    ),
  );
});

const readDestinationState = Effect.fn("LegacyImport.readDestinationState")(function* (
  currentDatabasePath: string,
): Effect.fn.Return<LegacyImportDestinationState, LegacyImportError> {
  if (!NodeFS.existsSync(currentDatabasePath)) return emptyLegacyImportDestinationState();
  return yield* Effect.acquireUseRelease(
    openReadonlyDatabase(currentDatabasePath),
    (database) => Effect.try(() => inspectLegacyImportDestinationState(database)),
    (database) => Effect.sync(() => database.close()).pipe(Effect.ignore),
  ).pipe(
    Effect.mapError(() =>
      sourceFailure("read-failed", "The destination environment could not be read."),
    ),
    Effect.catchDefect(() =>
      Effect.fail(sourceFailure("read-failed", "The destination environment could not be read.")),
    ),
  );
});

export class LegacyImportService extends Context.Service<
  LegacyImportService,
  {
    readonly importData: (
      request: LegacyImportRequest,
    ) => Effect.Effect<LegacyImportResult, LegacyImportError>;
  }
>()("t3/dataImport/LegacyImport/LegacyImportService") {}

export const makeLegacyImportService = Effect.fn("LegacyImport.makeLegacyImportService")(
  function* ({
    sourceStateDir,
    loadDestinationState,
  }: {
    readonly sourceStateDir: string;
    readonly loadDestinationState?: () => Effect.Effect<
      LegacyImportDestinationState,
      LegacyImportError
    >;
  }) {
    const config = yield* ServerConfig;
    const engine = yield* OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery;
    const serverSettings = yield* ServerSettingsService;
    const importHistoricalEvents = engine.importHistoricalEvents;
    const sourceDatabasePath = NodePath.join(sourceStateDir, "state.sqlite");
    const sourceSettingsPath = NodePath.join(sourceStateDir, "settings.json");
    const sourceAttachmentsDir = NodePath.join(sourceStateDir, "attachments");
    const loadCurrentDestinationState =
      loadDestinationState ?? (() => readDestinationState(config.dbPath));

    const importData = Effect.fn("LegacyImport.importData")(function* (
      request: LegacyImportRequest,
    ) {
      if (importHistoricalEvents === undefined) {
        return yield* sourceFailure(
          "read-failed",
          "This environment does not support importing T3 Code history.",
        );
      }

      const destination = yield* loadCurrentDestinationState();
      const source = yield* readLegacySourceSnapshot({
        sourceDatabasePath,
        currentDatabasePath: config.dbPath,
        projectIds: request.projectIds,
        destination,
      });
      const importedProjectIds = new Set(destination.projectIds);
      const importedThreadIds = new Set(destination.threadIds);
      const projectResults: LegacyImportResult["projects"][number][] = [];

      for (const plan of source.projects) {
        const sourceProjectId = plan.projectId;
        const sameIdProject = yield* snapshots
          .getProjectShellById(sourceProjectId)
          .pipe(
            Effect.mapError(() =>
              sourceFailure("read-failed", "The destination environment could not be read."),
            ),
          );
        const workspaceProject = Option.isSome(sameIdProject)
          ? Option.none()
          : yield* snapshots
              .getActiveProjectByWorkspaceRoot(plan.project.workspaceRoot)
              .pipe(
                Effect.mapError(() =>
                  sourceFailure("read-failed", "The destination environment could not be read."),
                ),
              );
        const activeProject = Option.orElse(sameIdProject, () => workspaceProject);
        const targetProjectId = Option.match(activeProject, {
          onNone: () => sourceProjectId,
          onSome: (project) => project.id,
        });
        const wasNewProject =
          Option.isNone(activeProject) && !importedProjectIds.has(sourceProjectId);
        let includeProject = wasNewProject;
        let importedThreadCount = 0;
        let repairedThreadCount = 0;
        let failedThreadCount = 0;
        let skippedAttachmentCount = 0;

        if (
          Option.isNone(activeProject) &&
          importedProjectIds.has(sourceProjectId) &&
          plan.threadIds.some((threadId) => !importedThreadIds.has(threadId))
        ) {
          projectResults.push({
            sourceProjectId,
            targetProjectId,
            title: plan.project.title,
            status: "failed",
            threadCount: 0,
            repairedThreadCount: 0,
            skippedAttachmentCount: 0,
            detail: "The matching project is no longer active on this server.",
          });
          continue;
        }

        if (plan.threadIds.length === 0 && includeProject) {
          const outcome = yield* Effect.exit(importHistoricalEvents(prepareProjectEvents(plan)));
          if (outcome._tag === "Failure") {
            yield* Effect.logWarning("Could not import an empty legacy T3 project", {
              projectId: sourceProjectId,
              cause: outcome.cause,
            });
            projectResults.push({
              sourceProjectId,
              targetProjectId,
              title: plan.project.title,
              status: "failed",
              threadCount: 0,
              repairedThreadCount: 0,
              skippedAttachmentCount: 0,
              detail: "The project could not be imported.",
            });
          } else {
            importedProjectIds.add(sourceProjectId);
            projectResults.push({
              sourceProjectId,
              targetProjectId,
              title: plan.project.title,
              status: "imported",
              threadCount: 0,
              repairedThreadCount: 0,
              skippedAttachmentCount: 0,
            });
          }
          continue;
        }

        for (const threadId of plan.threadIds) {
          if (importedThreadIds.has(threadId)) continue;

          const attachmentsOutcome = yield* Effect.exit(
            copyThreadAttachments({
              events: plan.events,
              threadId,
              sourceAttachmentsDir,
              targetAttachmentsDir: config.attachmentsDir,
            }),
          );
          if (attachmentsOutcome._tag === "Failure") {
            failedThreadCount += 1;
            yield* Effect.logWarning("Could not stage a legacy T3 thread's attachments", {
              projectId: sourceProjectId,
              threadId,
              cause: attachmentsOutcome.cause,
            });
            continue;
          }

          const events = prepareThreadEvents({
            plan,
            targetProjectId,
            threadId,
            includeProject,
            unavailableAttachmentPaths: attachmentsOutcome.value,
          });
          const continuation = plan.continuations.get(threadId);
          const outcome = yield* Effect.exit(
            importHistoricalEvents(
              events,
              continuation === undefined ? undefined : { continuation },
            ),
          );
          if (outcome._tag === "Failure") {
            failedThreadCount += 1;
            yield* Effect.logWarning("Could not import a legacy T3 thread", {
              projectId: sourceProjectId,
              threadId,
              cause: outcome.cause,
            });
            continue;
          }

          importedThreadCount += 1;
          skippedAttachmentCount += attachmentsOutcome.value.size;
          importedThreadIds.add(threadId);
          if (includeProject) {
            includeProject = false;
            importedProjectIds.add(sourceProjectId);
          }
          yield* Effect.yieldNow;
        }

        for (const threadId of plan.repairThreadIds) {
          const continuation = plan.continuations.get(threadId);
          if (continuation === undefined) continue;
          const outcome = yield* Effect.exit(importHistoricalEvents([], { continuation }));
          if (outcome._tag === "Failure") {
            failedThreadCount += 1;
            yield* Effect.logWarning("Could not restore a legacy T3 thread's provider context", {
              projectId: sourceProjectId,
              threadId,
              cause: outcome.cause,
            });
            continue;
          }
          repairedThreadCount += 1;
          yield* Effect.yieldNow;
        }

        if (failedThreadCount > 0) {
          projectResults.push({
            sourceProjectId,
            targetProjectId,
            title: plan.project.title,
            status: "failed",
            threadCount: importedThreadCount,
            repairedThreadCount,
            skippedAttachmentCount,
            detail: `${failedThreadCount} ${failedThreadCount === 1 ? "thread" : "threads"} could not be imported or repaired.`,
          });
          continue;
        }

        if (importedThreadCount === 0 && repairedThreadCount === 0) {
          projectResults.push({
            sourceProjectId,
            targetProjectId,
            title: plan.project.title,
            status: "skipped",
            threadCount: 0,
            repairedThreadCount: 0,
            skippedAttachmentCount: 0,
            detail: "No new work to import.",
          });
          continue;
        }

        projectResults.push({
          sourceProjectId,
          targetProjectId,
          title: plan.project.title,
          status: wasNewProject ? "imported" : "merged",
          threadCount: importedThreadCount,
          repairedThreadCount,
          skippedAttachmentCount,
        });
      }

      const settings = request.includeSettings
        ? yield* Effect.gen(function* () {
            if (!NodeFS.existsSync(sourceSettingsPath)) {
              return { status: "not-found" as const };
            }
            return yield* Effect.try({
              try: () => readLegacyImportPreferences(sourceSettingsPath),
              catch: () =>
                sourceFailure("read-failed", "The environment settings could not be read."),
            }).pipe(
              Effect.flatMap((preferences) => serverSettings.updateSettings(preferences)),
              Effect.as({ status: "imported" as const }),
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not import legacy T3 settings", { cause }).pipe(
                  Effect.as({
                    status: "failed" as const,
                    detail: "The environment settings could not be imported.",
                  }),
                ),
              ),
            );
          })
        : undefined;

      const importedProjects = projectResults.filter(
        (result) =>
          result.status === "imported" || (result.status === "merged" && result.threadCount > 0),
      );
      return {
        sourceKind: source.sourceKind,
        projects: projectResults,
        ...(settings === undefined ? {} : { settings }),
        importedProjectCount: importedProjects.length,
        importedThreadCount: projectResults.reduce(
          (count, project) => count + project.threadCount,
          0,
        ),
        repairedThreadCount: projectResults.reduce(
          (count, project) => count + project.repairedThreadCount,
          0,
        ),
        skippedAttachmentCount: projectResults.reduce(
          (count, project) => count + project.skippedAttachmentCount,
          0,
        ),
      } satisfies LegacyImportResult;
    });

    return LegacyImportService.of({ importData });
  },
);

export const make = makeLegacyImportService({
  sourceStateDir: NodePath.join(NodeOS.homedir(), ".t3", "userdata"),
});

export const layer = Layer.effect(LegacyImportService, make);
