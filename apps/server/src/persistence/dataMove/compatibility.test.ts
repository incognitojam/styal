// @effect-diagnostics nodeBuiltinImport:off - Pinned synthetic fixture input.
// @effect-diagnostics globalJsonInEffect:off - Raw persisted JSON is compared at the persistence boundary.
import * as NodeFS from "node:fs";
import * as NodeZlib from "node:zlib";
import { assert, it } from "@effect/vitest";
import * as C from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as EventStore from "../OrchestrationEventStore.ts";
import * as Sqlite from "../Sqlite.ts";
import * as Historical from "../historical.ts";
import { decodeStoredUrls } from "../../peer/PeerLinks.ts";
import * as AuthSessions from "../AuthSessions.ts";
import * as AuthPairingLinks from "../AuthPairingLinks.ts";
import * as ProviderRuntime from "../ProviderSessionRuntime.ts";
import * as ReviewGuides from "../PullRequestReviewGuides.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import { decodeStoredTask } from "../../scheduledTasks/ScheduledTaskService.ts";
import { decodePendingTask, decodePendingRequest } from "../../scheduledTasks/webhookDedupe.ts";

const Fixture = Schema.Struct({
  source: Schema.Literal("68e0ea592ac9a2262d04f2457d83e3f21d73ac73"),
  obligations: Schema.Array(Schema.String),
  shapes: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      value: Schema.Unknown,
      covers: Schema.Array(Schema.String),
    }),
  ),
});
const fixture = Schema.decodeSync(Schema.fromJsonString(Fixture))(
  NodeZlib.gunzipSync(
    NodeFS.readFileSync(new URL("./fixtures/compatibility.json.gz", import.meta.url)),
  ).toString(),
);
const decodeScalar = Schema.decodeUnknownSync(
  Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
);
const decodeString = Schema.decodeUnknownSync(Schema.String);
const decodeEvent = Schema.decodeUnknownSync(C.OrchestrationV2DomainEventJson);
const decodeProjectEvent = Schema.decodeUnknownSync(C.ApplicationProjectEvent);
const decodeTask = Schema.decodeUnknownSync(C.ScheduledTask);
const decodeAuth = Schema.decodeUnknownSync(AuthSessions.AuthSessionRecord);
const decodePair = Schema.decodeUnknownSync(AuthPairingLinks.AuthPairingLinkRecord);
const decodeRuntime = Schema.decodeUnknownSync(ProviderRuntime.ProviderSessionRuntime);
const decodeEffect = Schema.decodeUnknownSync(EffectOutbox.OrchestrationEffectRequestV2);
const payload = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const projections = {
  AppThreadJson: "threads",
  RunJson: "runs",
  RunAttemptJson: "run_attempts",
  ExecutionNodeJson: "nodes",
  ProviderSessionJson: "provider_sessions",
  ProviderThreadJson: "provider_threads",
  ProviderTurnJson: "provider_turns",
  RuntimeRequestJson: "runtime_requests",
  ConversationMessageJson: "messages",
  PlanArtifact: "plans",
  TurnItemJson: "turn_items",
  CheckpointScopeJson: "checkpoint_scopes",
  CheckpointJson: "checkpoints",
  ContextHandoffJson: "context_handoffs",
  ContextTransferJson: "context_transfers",
  SubagentJson: "subagents",
} as const;
const layerTest = Layer.mergeAll(
  ProjectionStore.layer,
  ProjectStore.layer,
  EventStore.layer,
  AuthSessions.layer,
  AuthPairingLinks.layer,
  ProviderRuntime.layer,
  ReviewGuides.layer,
  EffectOutbox.layer,
).pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect("reads every systematic source projection witness through the startup reader", () =>
  Effect.gen(function* () {
    assert.deepEqual(
      [...new Set(fixture.shapes.flatMap((shape) => shape.covers))].sort(),
      [...fixture.obligations].sort(),
    );
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    type ProjectionColumn = {
      readonly name: string;
      readonly pk: number;
      readonly notnull: number;
      readonly dflt_value: unknown;
      readonly type: string;
    };
    const tables = new Map<string, ReadonlyArray<ProjectionColumn>>();
    for (const kind of Object.values(projections))
      tables.set(
        kind,
        yield* sql.unsafe<ProjectionColumn>(
          `PRAGMA table_info(orchestration_v2_projection_${kind})`,
        ),
      );
    const insert = (kind: string, value: unknown) => {
      const p = payload(value);
      const row: Record<string, string | number | null> = {};
      for (const column of tables.get(kind)!) {
        const camel = column.name.replace(/_([a-z])/g, (_, s: string) => s.toUpperCase());
        let v = column.pk
          ? p.id
          : column.name === "payload_json"
            ? JSON.stringify(p)
            : ["thread_id", "source_thread_id", "target_thread_id"].includes(column.name)
              ? "synthetic"
              : column.name === "provider"
                ? "codex"
                : p[camel];
        if (typeof v === "boolean") v = Number(v);
        if (v === undefined) {
          if (!column.notnull) v = null;
          else if (column.dflt_value !== null) continue;
          else v = column.type === "INTEGER" ? 1 : "synthetic";
        }
        row[column.name] = decodeScalar(v);
      }
      return sql.unsafe(
        `INSERT OR REPLACE INTO orchestration_v2_projection_${kind} (${Object.keys(row).join(",")}) VALUES (${Object.keys(
          row,
        )
          .map(() => "?")
          .join(",")})`,
        Object.values(row),
      );
    };
    const thread = fixture.shapes.find((shape) => shape.name === "projection.AppThreadJson")!.value;
    yield* insert("threads", thread);
    yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings
      (provider_session_id,thread_id) VALUES ('synthetic','synthetic')`;
    const seen = new Set<string>();
    for (const shape of fixture.shapes) {
      if (!shape.name.startsWith("projection.")) continue;
      const kind = projections[shape.name.slice(11) as keyof typeof projections];
      assert.isDefined(kind, shape.name);
      yield* insert(kind, shape.value);
      assert.deepEqual(yield* store.getUnreadableThreadIds(), [], shape.name);
      if (kind === "threads") yield* insert("threads", thread);
      else yield* sql.unsafe(`DELETE FROM orchestration_v2_projection_${kind}`);
      seen.add(kind);
    }
    assert.equal(seen.size, Object.keys(projections).length);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "reads materialized fork history once and keeps its local item count through rollback",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const thread = payload(
        fixture.shapes.find((shape) => shape.name === "projection.AppThreadJson")!.value,
      );
      const run = payload(
        fixture.shapes.find((shape) => shape.name === "projection.RunJson")!.value,
      );
      const at = "2026-01-01T00:00:00.000Z";
      let sequence = 0;
      const apply = (threadId: string, type: string, value: unknown) =>
        store.apply(
          decodeEvent({
            id: `synthetic-history-${++sequence}`,
            threadId,
            type,
            occurredAt: at,
            payload: value,
          }),
        );
      yield* apply("synthetic", "thread.created", thread);
      yield* apply("synthetic", "run.created", { ...run, status: "completed", completedAt: at });
      const item = {
        id: "synthetic-parent-item",
        threadId: "synthetic",
        runId: "synthetic",
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1000001,
        status: "completed",
        title: "Synthetic history",
        startedAt: at,
        completedAt: at,
        updatedAt: at,
        type: "system_notice",
        message: "Synthetic history",
      };
      yield* apply("synthetic", "turn-item.updated", item);
      yield* apply("synthetic-materialized", "thread.created", {
        ...thread,
        id: "synthetic-materialized",
        forkedFrom: { type: "run", threadId: "synthetic", runId: "synthetic" },
        forkHistoryMaterialized: true,
      });
      yield* apply("synthetic-materialized", "turn-item.updated", {
        ...item,
        id: "synthetic-local-item",
        threadId: "synthetic-materialized",
        runId: null,
        ordinal: 1,
      });
      const id = C.ThreadId.make("synthetic-materialized");
      assert.deepEqual(
        (yield* store.getThreadProjection(id)).turnItems.map((item) => item.id),
        ["synthetic-local-item"],
      );
      assert.equal((yield* store.getThreadShell(id))!.itemCount, 1);
      yield* apply("synthetic", "run.updated", { ...run, status: "rolled_back", completedAt: at });
      assert.deepEqual(
        (yield* store.getThreadProjection(id)).turnItems.map((item) => item.id),
        ["synthetic-local-item"],
      );
      assert.equal((yield* store.getThreadShell(id))!.itemCount, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("reads source event witnesses and leaves opaque historical events untouched", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* EventStore.OrchestrationEventStore;
    for (const shape of fixture.shapes) {
      if (shape.name !== "thread-event" && shape.name !== "project-event") continue;
      const event = payload(shape.value);
      const type = decodeString(event.type);
      const project = shape.name === "project-event";
      const rawPayload = JSON.stringify(event.payload);
      const metadata = project
        ? JSON.stringify(event.metadata)
        : JSON.stringify(
            Object.fromEntries(
              ["runId", "nodeId", "driver", "providerInstanceId", "rawEventId"]
                .filter((key) => event[key] !== undefined)
                .map((key) => [key, event[key]]),
            ),
          );
      const row = {
        sequence: 1,
        event_id: String(event.id ?? event.eventId),
        command_id: null,
        aggregate_kind: project ? ("project" as const) : ("thread" as const),
        stream_id: String(project ? event.aggregateId : event.threadId),
        event_type: type,
        occurred_at: String(event.occurredAt),
        payload_json: rawPayload,
        metadata_json: metadata,
        application_event_version: 2,
        causation_event_id: null,
        correlation_id: null,
      };
      if (Historical.isHistoricalEventType(type)) {
        yield* sql`DELETE FROM orchestration_events`;
        yield* sql`INSERT INTO orchestration_events
          (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version)
          VALUES (${row.event_id},'thread',${row.stream_id},1,${type},${row.occurred_at},'server',${rawPayload},'{}',2)`;
        assert.deepEqual(yield* store.readAgentEvents().pipe(Stream.runCollect), []);
        const stored = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_events`;
        assert.equal(stored[0]!.payload_json, rawPayload);
        yield* store.appendAgentEvents({
          events: [
            decodeEvent({
              id: "synthetic-new-event",
              threadId: row.stream_id,
              type: "provider-session.detached",
              occurredAt: row.occurred_at,
              payload: { providerSessionId: "synthetic-session", detachedAt: row.occurred_at },
            }),
          ],
        });
        assert.lengthOf(yield* store.readAgentEvents().pipe(Stream.runCollect), 1);
      } else yield* EventStore.rowToApplicationStoredEvent(row);
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "keeps adapted requests and background work inert after an ordinary projection write",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const find = (name: string, predicate: (value: Record<string, unknown>) => boolean) =>
        fixture.shapes
          .filter((shape) => shape.name === name)
          .map((shape) => payload(shape.value))
          .find(predicate)!;
      const thread = find("projection.AppThreadJson", () => true);
      const now = "2026-01-01T00:00:00.000Z";
      const event = (type: string, value: unknown) =>
        decodeEvent({
          id: "synthetic-event",
          threadId: thread.id,
          occurredAt: now,
          type,
          payload: Historical.threadEventPayload(type, value),
        });
      yield* store.apply(event("thread.created", thread));
      const request = find(
        "projection.RuntimeRequestJson",
        (value) => payload(value.responseCapability).type === "server",
      );
      yield* store.apply(event("runtime-request.updated", request));
      yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status='pending',payload_json=${JSON.stringify(request)}`;
      const records = yield* store.getThreadRecords(C.ThreadId.make(String(thread.id)), [
        "runtimeRequests",
      ]);
      assert.lengthOf(records.runtimeRequests, 1);
      const read = records.runtimeRequests[0]!;
      assert.equal(read.status, "expired");
      assert.equal(read.responseCapability.type, "not_resumable");
      yield* store.apply(
        event("thread.metadata-updated", { ...thread, title: "Renamed synthetic thread" }),
      );
      const reread = yield* store.getThreadRecords(C.ThreadId.make(String(thread.id)), [
        "runtimeRequests",
      ]);
      assert.equal(reread.runtimeRequests[0]!.status, "expired");
      assert.equal(reread.runtimeRequests[0]!.responseCapability.type, "not_resumable");
      const requestRows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_runtime_requests`;
      assert.equal(requestRows[0]!.payload_json, JSON.stringify(request));
      yield* store.apply({
        ...event("runtime-request.updated", request),
        type: "runtime-request.updated",
        payload: { ...read, feedback: "Synthetic historical note" },
      });
      const persistedRequest = yield* sql<{
        status: string;
        capability: string;
        feedback: string;
      }>`SELECT status,json_extract(payload_json,'$.responseCapability.type') AS capability,json_extract(payload_json,'$.feedback') AS feedback FROM orchestration_v2_projection_runtime_requests`;
      assert.equal(persistedRequest[0]!.status, "expired");
      assert.equal(persistedRequest[0]!.capability, "not_resumable");
      assert.equal(persistedRequest[0]!.feedback, "Synthetic historical note");
      const providerSource = find(
        "projection.ProviderThreadJson",
        (value) =>
          Array.isArray(value.pendingBackgroundTasks) &&
          value.pendingBackgroundTasks.some(
            (task: unknown) =>
              typeof payload(task).command === "object" && payload(task).command !== null,
          ),
      );
      const provider = { ...providerSource, appThreadId: String(thread.id) };
      yield* store.apply(event("provider-thread.updated", provider));
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json=${JSON.stringify(provider)}`;
      const providerRecords = yield* store.getThreadRecords(C.ThreadId.make(String(thread.id)), [
        "providerThreads",
      ]);
      assert.lengthOf(providerRecords.providerThreads, 1);
      assert.deepEqual(providerRecords.providerThreads[0]!.pendingBackgroundTasks, []);
      yield* store.apply(
        event("thread.metadata-updated", { ...thread, title: "Renamed synthetic owner" }),
      );
      const afterWrite = yield* store.getThreadRecords(C.ThreadId.make(String(thread.id)), [
        "providerThreads",
      ]);
      assert.deepEqual(afterWrite.providerThreads[0]!.pendingBackgroundTasks, []);
      const providerRows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_provider_threads`;
      assert.equal(providerRows[0]!.payload_json, JSON.stringify(provider));
      yield* store.apply({
        ...event("provider-thread.updated", provider),
        type: "provider-thread.updated",
        payload: {
          ...providerRecords.providerThreads[0]!,
          nativeMetadata: { title: "Renamed synthetic provider thread" },
        },
      });
      const persistedProvider = yield* sql<{
        pending: number;
        title: string;
      }>`SELECT json_array_length(payload_json,'$.pendingBackgroundTasks') AS pending,json_extract(payload_json,'$.nativeMetadata.title') AS title FROM orchestration_v2_projection_provider_threads`;
      assert.equal(persistedProvider[0]!.pending, 0);
      assert.equal(persistedProvider[0]!.title, "Renamed synthetic provider thread");
      const originalTasks = Array.isArray(providerSource.pendingBackgroundTasks)
        ? providerSource.pendingBackgroundTasks
        : [];
      const future = {
        ...provider,
        pendingBackgroundTasks: originalTasks.map((task: unknown) => ({
          ...payload(task),
          kind: "synthetic-retired-kind",
        })),
      };
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json=${JSON.stringify(future)}`;
      const futureRead = yield* store.getThreadRecords(C.ThreadId.make(String(thread.id)), [
        "providerThreads",
      ]);
      assert.deepEqual(futureRead.providerThreads[0]!.pendingBackgroundTasks, []);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "excludes historical pending requests before shell selection and settlement filtering",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const source = payload(
        fixture.shapes.find((shape) => shape.name === "projection.AppThreadJson")!.value,
      );
      const thread = {
        ...source,
        archivedAt: null,
        deletedAt: null,
        settledOverride: null,
        pinnedAt: null,
        autoSettleDisabledAt: null,
        forkedFrom: null,
        lineage: { ...payload(source.lineage), relationshipToParent: null },
      };
      const threadId = C.ThreadId.make(String(source.id));
      const event = (type: string, value: unknown) =>
        decodeEvent({
          id: "synthetic-event",
          threadId,
          occurredAt: "2026-01-01T00:00:00.000Z",
          type,
          payload: Historical.threadEventPayload(type, value),
        });
      yield* store.apply(event("thread.created", thread));
      const sourceRequest = fixture.shapes
        .filter((shape) => shape.name === "projection.RuntimeRequestJson")
        .map((shape) => payload(shape.value))
        .find((value) => payload(value.responseCapability).type === "server")!;
      const historical = {
        ...sourceRequest,
        id: "synthetic-historical-request",
        appThreadId: threadId,
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z",
        resolvedAt: null,
      };
      yield* store.apply(event("runtime-request.updated", historical));
      yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status='pending', payload_json=${JSON.stringify(historical)}`;
      const historicalShell = yield* store.getThreadShell(threadId);
      assert.isNull(historicalShell?.pendingRuntimeRequest);
      assert.deepEqual(
        (yield* store.getSettlementCandidates(threadId)).map((row) => row.id),
        [threadId],
      );
      const current = {
        ...historical,
        id: "synthetic-current-request",
        createdAt: "2025-01-01T00:00:00.000Z",
        responseCapability: { type: "not_resumable", reason: "Synthetic request" },
      };
      yield* store.apply(event("runtime-request.updated", current));
      const mixedShell = yield* store.getThreadShell(threadId);
      assert.equal(mixedShell?.pendingRuntimeRequest?.id, current.id);
      for (const [status, id] of [
        ["pending", current.id],
        ["expired", historical.id],
      ] as const) {
        const rows = yield* store.getThreadRecords(threadId, ["runtimeRequests"], {
          runtimeRequestStatuses: [status],
        });
        assert.deepEqual(
          rows.runtimeRequests.map((row) => row.id),
          [id],
        );
      }
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "loads historical project icons as inert scripts and still reads the project after renaming",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectStore.ProjectStoreV2;
      const sql = yield* SqlClient.SqlClient;
      for (const [icon, encoded] of [
        ["desktop", false],
        ["database", false],
        ["deploy", false],
        ["desktop", true],
        ["database", true],
        ["deploy", true],
      ] as const) {
        const source = fixture.shapes
          .filter((shape) => shape.name === "project-event")
          .map((shape) => payload(shape.value))
          .find((event) => event.type === "project.created")!;
        const raw = payload(source.payload);
        const input = {
          ...source,
          payload: {
            ...raw,
            scripts: [
              {
                id: "synthetic-action",
                name: "Synthetic historical action",
                command: "synthetic-command",
                icon,
                runOnWorktreeCreate: false,
              },
            ],
          },
        };
        const adapted = Historical.projectEvent(
          encoded
            ? {
                ...input,
                payload: { ...input.payload, scripts: JSON.stringify(input.payload.scripts) },
              }
            : input,
        );
        assert.deepEqual(payload(payload(adapted).payload).scripts, [
          { ...input.payload.scripts[0], icon: "play" },
        ]);
        const event = decodeProjectEvent(adapted);
        yield* store.apply(event);
        const id = C.ProjectId.make(String(raw.projectId));
        const shell = yield* store.getShell(id);
        assert.equal(shell._tag, "Some");
        if (shell._tag !== "Some") return;
        yield* store.apply({
          ...event,
          type: "project.meta-updated",
          payload: {
            projectId: id,
            title: "Renamed synthetic project",
            updatedAt: String(raw.updatedAt),
          },
        });
        const after = yield* store.getShell(id);
        assert.equal(after._tag, "Some");
        if (after._tag !== "Some") return;
        assert.equal(after.value.title, "Renamed synthetic project");
        yield* sql`DELETE FROM projection_projects`;
      }
    }).pipe(Effect.provide(layerTest)),
);

it.effect("reads source auxiliary columns and runtime rows without starting their services", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sessions = yield* AuthSessions.AuthSessionRepository;
    const pairing = yield* AuthPairingLinks.AuthPairingLinkRepository;
    const runtimes = yield* ProviderRuntime.ProviderSessionRuntimeRepository;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const guides = yield* ReviewGuides.PullRequestReviewGuideRepository;
    const tasks = fixture.shapes.filter((shape) => shape.name === "column.ScheduledTask");
    const baseTask = payload(tasks[0]!.value);
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    const first = (name: string) => payload(fixture.shapes.find((s) => s.name === name)!.value);
    const baseThread = first("projection.AppThreadJson");
    const baseMessage = first("projection.ConversationMessageJson");
    const baseSnapshot = first("column.ThreadPullRequestSnapshot");
    const baseRequest = first("column.WebhookRequest");
    const baseProject = fixture.shapes
      .filter((s) => s.name === "project-event")
      .map((s) => payload(s.value))
      .find((event) => event.type === "project.created")!;
    const threadId = C.ThreadId.make(String(baseThread.id));
    const event = (type: string, value: unknown) =>
      decodeEvent({
        id: "synthetic-aux",
        threadId,
        type,
        payload: value,
        occurredAt: "2026-01-01T00:00:00.000Z",
      });
    yield* projection.apply(event("thread.created", baseThread));
    yield* projection.apply(event("message.updated", baseMessage));
    for (const shape of fixture.shapes) {
      if (!shape.name.startsWith("runtime.") && !shape.name.startsWith("column.")) continue;
      const value =
        typeof shape.value === "object" && shape.value !== null && !Array.isArray(shape.value)
          ? payload(shape.value)
          : {};
      if (shape.name === "runtime.ProviderSessionRuntime") {
        const row = decodeRuntime(value);
        yield* runtimes.upsert(row);
        assert.equal((yield* runtimes.getByThreadId({ threadId: row.threadId }))._tag, "Some");
      } else if (shape.name === "runtime.AuthSessionRecord") {
        const row = decodeAuth({
          ...value,
          scopes: Array.isArray(value.scopes)
            ? value.scopes.filter((scope) => scope !== "devices:operate")
            : value.scopes,
        });
        yield* sql`DELETE FROM auth_sessions`;
        yield* sessions.create(row);
        yield* sql`UPDATE auth_sessions SET scopes=${JSON.stringify(value.scopes)}`;
        assert.equal((yield* sessions.getById({ sessionId: row.sessionId }))._tag, "Some");
      } else if (shape.name === "runtime.AuthPairingLinkRecord") {
        const row = decodePair({
          requiresConnectApproval: 0,
          connectApproved: 0,
          requestedClient: null,
          ...value,
        });
        yield* sql`DELETE FROM auth_pairing_links`;
        yield* pairing.create({
          ...row,
          requiresConnectApproval: row.requiresConnectApproval === 1,
        });
        yield* sql`UPDATE auth_pairing_links SET scopes=${String(value.scopes)}, requested_client_json=${row.requestedClient === null ? null : JSON.stringify(row.requestedClient)}`;
        assert.equal((yield* pairing.getByCredential({ credential: row.credential }))._tag, "Some");
      } else if (shape.name === "column.AuthEnvironmentScopes") {
        yield* sql`UPDATE auth_sessions SET scopes=${JSON.stringify(shape.value)}`;
        const read = yield* sessions.getById({ sessionId: C.AuthSessionId.make("synthetic") });
        assert.equal(read._tag, "Some");
        if (read._tag === "Some")
          assert.isFalse(read.value.scopes.some((scope) => String(scope) === "devices:operate"));
      } else if (shape.name === "column.AuthClientMetadata") {
        yield* sql`UPDATE auth_pairing_links SET requested_client_json=${JSON.stringify(value)}`;
        assert.equal((yield* pairing.getByCredential({ credential: "synthetic" }))._tag, "Some");
      } else if (shape.name === "column.AgentSessionImportSource") {
        yield* sql`UPDATE provider_session_runtime SET runtime_payload_json=${JSON.stringify({ importedTranscripts: [value] })}`;
        assert.equal((yield* runtimes.getByThreadId({ threadId }))._tag, "Some");
      } else if (shape.name === "column.StringList") {
        assert.deepEqual(yield* decodeStoredUrls(JSON.stringify(shape.value)), shape.value);
      } else if (shape.name === "column.StringMap") {
        yield* decodePendingRequest(JSON.stringify({ ...baseRequest, headers: value }));
      } else if (shape.name === "column.ApplicationEventMetadata") {
        yield* EventStore.rowToApplicationStoredEvent({
          sequence: 1,
          event_id: "synthetic-meta",
          command_id: null,
          aggregate_kind: "project",
          stream_id: "synthetic",
          event_type: "project.meta-updated",
          occurred_at: "2026-01-01T00:00:00.000Z",
          payload_json: JSON.stringify({
            projectId: "synthetic",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
          metadata_json: JSON.stringify(value),
          application_event_version: 2,
          causation_event_id: null,
          correlation_id: null,
        });
      } else if (shape.name === "column.ProjectScript") {
        yield* projects.apply(
          decodeProjectEvent(
            Historical.projectEvent({
              ...baseProject,
              payload: { ...payload(baseProject.payload), scripts: [value] },
            }),
          ),
        );
        assert.equal((yield* projects.getShell(C.ProjectId.make("synthetic")))._tag, "Some");
      } else if (
        [
          "column.ThreadPullRequestSnapshot",
          "column.ThreadPullRequestStack",
          "column.ThreadLinkedPullRequest",
        ].includes(shape.name)
      ) {
        const link = {
          host: "example.test",
          repository: "synthetic/project",
          number: 1,
          url: "https://example.test/synthetic/project/pull/1",
          source: "manual",
          linkedAt: "2026-01-01T00:00:00.000Z",
          snapshot: baseSnapshot,
          stack: null,
        };
        const raw =
          shape.name === "column.ThreadLinkedPullRequest"
            ? { ...baseThread, linkedPullRequest: value }
            : {
                ...baseThread,
                pullRequests: [
                  {
                    ...link,
                    [shape.name === "column.ThreadPullRequestSnapshot" ? "snapshot" : "stack"]:
                      value,
                  },
                ],
              };
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=${JSON.stringify(raw)}`;
        yield* projection.getThread(threadId);
      } else if (
        shape.name === "column.ChatAttachment" ||
        shape.name === "column.OrchestrationMessageContext"
      ) {
        const raw = {
          ...baseMessage,
          [shape.name === "column.ChatAttachment" ? "attachments" : "context"]:
            shape.name === "column.ChatAttachment" ? [value] : value,
        };
        yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json=${JSON.stringify(raw)}`;
        assert.lengthOf((yield* projection.getThreadRecords(threadId, ["messages"])).messages, 1);
      } else if (
        shape.name === "column.ScheduledTask" ||
        shape.name === "column.ScheduledTaskSchedule"
      ) {
        const raw =
          shape.name === "column.ScheduledTask" ? value : { ...baseTask, schedule: value };
        const task = decodeTask(raw);
        yield* decodePendingTask(JSON.stringify(raw));
        const read = yield* decodeStoredTask({
          task_id: task.id,
          title: task.title,
          prompt: task.prompt,
          enabled: Number(task.enabled),
          schedule_json: JSON.stringify(raw.schedule),
          project_id: task.projectId,
          thread_id: task.threadId,
          thread_mode: task.threadMode ?? "new_thread",
          workspace_strategy_json: JSON.stringify(raw.workspaceStrategy),
          model_selection_json: JSON.stringify(raw.modelSelection),
          runtime_mode: task.runtimeMode,
          interaction_mode: task.interactionMode,
          created_by: task.createdBy,
          creation_source: task.creationSource,
          created_at: String(raw.createdAt),
          updated_at: String(raw.updatedAt),
          next_run_at: task.nextRunAt,
          last_run_at: task.lastRunAt,
          last_run_status: task.lastRunStatus,
          last_run_error: task.lastRunError,
          run_count: task.runCount,
          webhook_token: null,
          webhook_secret: null,
        });
        assert.equal(read.id, task.id);
      } else if (shape.name === "column.WebhookRequest") {
        yield* decodePendingRequest(JSON.stringify(value));
      } else if (shape.name === "column.PullRequestReviewGuide") {
        yield* sql`DELETE FROM pull_request_review_guides`;
        yield* sql`INSERT INTO pull_request_review_guides(host,repository,number,guide_json)
          VALUES('example.test','synthetic/project',1,${JSON.stringify(value)})`;
        assert.equal(
          (yield* guides.get({ host: "example.test", repository: "synthetic/project", number: 1 }))
            ._tag,
          "Some",
        );
      } else if (
        shape.name === "column.ModelSelection" ||
        shape.name === "column.StoredProjectIcon"
      ) {
        const source = fixture.shapes
          .filter((s) => s.name === "project-event")
          .map((s) => payload(s.value))
          .find((event) => event.type === "project.created")!;
        const event = decodeProjectEvent(Historical.projectEvent(source));
        yield* projects.apply(event);
        const column =
          shape.name === "column.ModelSelection"
            ? "default_model_selection_json"
            : "project_icon_json";
        yield* sql.unsafe(`UPDATE projection_projects SET ${column}=?`, [JSON.stringify(value)]);
        assert.equal(
          (yield* projects.getShell(C.ProjectId.make(String(payload(source.payload).projectId))))
            ._tag,
          "Some",
        );
      } else {
        assert.fail(`Missing runtime reader for ${shape.name}`);
      }
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reads execution-only source effects and never claims removed fork effects", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    for (const shape of fixture.shapes) {
      if (shape.name !== "execution.EffectRequest") continue;
      const value = payload(shape.value);
      const type = decodeString(value.type);
      yield* sql`DELETE FROM orchestration_v2_effect_outbox`;
      yield* sql`INSERT INTO orchestration_v2_effect_outbox
        (effect_id,command_id,thread_id,effect_type,payload_json,status,attempt_count,available_at,created_at,updated_at)
        VALUES ('synthetic-effect','synthetic-command','synthetic',${type},${JSON.stringify(value)},'pending',0,'1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z')`;
      if (Historical.isHistoricalEffectType(type)) {
        assert.equal((yield* outbox.get("synthetic-effect"))._tag, "None");
        assert.deepEqual(yield* outbox.listByCommandId(C.CommandId.make("synthetic-command")), []);
        assert.equal((yield* outbox.claimNext({ workerId: "synthetic-worker" }))._tag, "None");
        const [stored] = yield* sql<{
          status: string;
          payload_json: string;
        }>`SELECT status,payload_json FROM orchestration_v2_effect_outbox`;
        assert.equal(stored!.status, "pending");
        assert.equal(stored!.payload_json, JSON.stringify(value));
        yield* sql`INSERT INTO orchestration_v2_effect_outbox
          (effect_id,command_id,thread_id,effect_type,payload_json,status,attempt_count,available_at,created_at,updated_at)
          VALUES ('synthetic-current','synthetic-command','synthetic','scheduled-tasks.cleanup','{"type":"scheduled-tasks.cleanup"}',
            'pending',0,'1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z')`;
        const claimed = yield* outbox.claimNext({ workerId: "synthetic-worker" });
        assert.equal(claimed._tag, "Some");
        if (claimed._tag === "Some") assert.equal(claimed.value.id, "synthetic-current");
      } else {
        decodeEffect(value);
        assert.equal((yield* outbox.get("synthetic-effect"))._tag, "Some", type);
      }
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "isolates a malformed prompt anchor and its compacted event from other threads on reconnect",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* EventStore.OrchestrationEventStore;
      const subagent = fixture.shapes
        .filter((shape) => shape.name === "thread-event")
        .map((shape) => payload(shape.value))
        .find((event) => event.type === "subagent.updated")!;
      const [anchor] = yield* sql<{ sequence: number }>`INSERT INTO orchestration_events
      (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version)
      VALUES ('synthetic-bad-anchor','thread','synthetic',1,'subagent.updated','2026-01-01T00:00:00.000Z','server','not JSON','{}',2)
      RETURNING sequence`;
      const compact = {
        ...payload(subagent.payload),
        prompt: "",
        promptSequence: anchor!.sequence,
      };
      yield* sql`INSERT INTO orchestration_events
      (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version)
      VALUES ('synthetic-compacted','thread','synthetic',2,'subagent.updated','2026-01-01T00:00:00.000Z','server',${JSON.stringify(compact)},'{}',2)`;
      const request = fixture.shapes
        .filter((shape) => shape.name === "projection.RuntimeRequestJson")
        .map((shape) => payload(shape.value))
        .find((value) => payload(value.responseCapability).type === "server")!;
      yield* sql`INSERT INTO orchestration_events
      (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version)
      VALUES ('synthetic-bad-request','thread','synthetic',3,'runtime-request.updated','2026-01-01T00:00:00.000Z','server',${JSON.stringify({ ...request, status: { toString: "synthetic" } })},'{}',2)`;
      const [good] = yield* store.appendAgentEvents({
        events: [
          decodeEvent({
            id: "synthetic-other-event",
            threadId: "synthetic-other",
            type: "provider-session.detached",
            occurredAt: "2026-01-01T00:00:00.000Z",
            payload: {
              providerSessionId: "synthetic-session",
              detachedAt: "2026-01-01T00:00:00.000Z",
            },
          }),
        ],
      });
      const read = yield* store
        .readApplicationEvents({
          afterSequence: 0,
          throughSequence: good!.sequence,
          skipUnknownEventTypes: true,
        })
        .pipe(Stream.runCollect);
      assert.lengthOf(read, 1);
      assert.equal(read[0]!.sequence, good!.sequence);
    }).pipe(Effect.provide(layerTest)),
);
