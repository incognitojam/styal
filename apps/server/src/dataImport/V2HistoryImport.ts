import {
  CommandId,
  EventId,
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjectionJson,
  type OrchestrationV2ThreadProjection,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Schema from "effect/Schema";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { attachmentRelativePath } from "../attachmentStore.ts";
import type { ReadonlyDatabase } from "./LegacyImportPreview.ts";

const tableRows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })));
const decodeProjection = Schema.decodeUnknownSync(OrchestrationV2ThreadProjectionJson);
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);
const decodeThreadDate = Schema.decodeUnknownSync(Schema.Struct({ updatedAt: Schema.String }));
const rows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ payload_json: Schema.String })));
const json = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const fields = {
  runs: "runs",
  attempts: "run_attempts",
  nodes: "nodes",
  subagents: "subagents",
  providerThreads: "provider_threads",
  providerTurns: "provider_turns",
  messages: "messages",
  plans: "plans",
  turnItems: "turn_items",
  checkpointScopes: "checkpoint_scopes",
  checkpoints: "checkpoints",
  contextHandoffs: "context_handoffs",
} as const;

/** Read the canonical, unbounded history rather than the upstream UI's bounded snapshot. */
export function readV2SourceProjection(
  database: ReadonlyDatabase,
  threadId: ThreadId,
): OrchestrationV2ThreadProjection {
  const tables = new Set(
    tableRows(database.all("SELECT name FROM sqlite_master WHERE type = 'table'")).map(
      (row) => row.name,
    ),
  );
  const read = (table: string) =>
    tables.has(table)
      ? rows(
          database.all(`SELECT payload_json FROM ${table} WHERE thread_id = ? ORDER BY rowid`, [
            threadId,
          ]),
        ).map((row) => json(row.payload_json))
      : [];
  const thread = read("orchestration_v2_projection_threads")[0];
  const legacyTurnUsage = read("styal_projection_legacy_turn_usage")[0];
  const records = Object.fromEntries(
    Object.entries(fields).map(([field, suffix]) => [
      field,
      read(`orchestration_v2_projection_${suffix}`),
    ]),
  );
  const transfers = tables.has("orchestration_v2_projection_context_transfers")
    ? rows(
        database.all(
          "SELECT payload_json FROM orchestration_v2_projection_context_transfers WHERE source_thread_id = ? OR target_thread_id = ? ORDER BY rowid",
          [threadId, threadId],
        ),
      ).map((row) => json(row.payload_json))
    : [];
  return decodeProjection({
    ...records,
    thread,
    providerSessions: [],
    runtimeRequests: [],
    contextTransfers: transfers,
    visibleTurnItems: [],
    updatedAt: decodeThreadDate(thread).updatedAt,
    ...(legacyTurnUsage === undefined ? {} : { legacyTurnUsage }),
  });
}

const active = new Set([
  "idle",
  "pending",
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

export const makeV2HistoryWriter = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  return Effect.fn("V2HistoryImport.write")(function* (
    source: OrchestrationV2ThreadProjection,
    targetProjectId: ProjectId,
    unavailableAttachments: ReadonlySet<string> = new Set(),
    repairOnly = false,
  ) {
    const existingThread = repairOnly
      ? (yield* projections.getThreadProjection(source.thread.id)).thread
      : source.thread;
    const thread = {
      ...existingThread,
      activeProviderThreadId: source.thread.activeProviderThreadId,
      projectId: targetProjectId,
      titleRegeneration: null,
      limitRecovery: null,
    };
    const prefix = `import:v2:${thread.id}`;
    const events: OrchestrationV2DomainEvent[] = [];
    const event = (type: OrchestrationV2DomainEvent["type"], id: string, payload: unknown) => {
      events.push(
        decodeEvent({
          id: EventId.make(`${prefix}:${type}:${id}`),
          type,
          threadId: thread.id,
          occurredAt: thread.updatedAt,
          payload,
        }),
      );
    };
    if (repairOnly) {
      const provider = source.providerThreads.find(
        (entry) => entry.id === source.thread.activeProviderThreadId,
      );
      if (provider === undefined) return;
      event("provider-thread.updated", provider.id, {
        ...provider,
        providerSessionId: null,
        status: "not_loaded",
        pendingBackgroundTasks: [],
      });
      event("thread.metadata-updated", thread.id, thread);
      return yield* sink.commitCommand({
        commandId: CommandId.make(
          `${prefix}:continuation:${provider.nativeThreadRef?.nativeId}:${provider.nativeConversationHeadRef?.nativeId}`,
        ),
        commandType: "thread.history.import",
        threadId: thread.id,
        acceptedAt: thread.updatedAt,
        events,
        effects: [],
      });
    }
    event("thread.created", thread.id, thread);
    // Process-owned work cannot resume in another environment. Its history and recorded usage remain.
    for (const run of source.runs)
      event("run.created", run.id, {
        ...run,
        ...(active.has(run.status)
          ? { status: "cancelled", completedAt: thread.updatedAt, queueHeld: false }
          : {}),
        delegatedCompletion: undefined,
      });
    for (const attempt of source.attempts)
      event("run-attempt.created", attempt.id, {
        ...attempt,
        ...(active.has(attempt.status)
          ? { status: "cancelled", completedAt: thread.updatedAt }
          : {}),
      });
    for (const node of source.nodes)
      event("node.updated", node.id, {
        ...node,
        runtimeRequestId: null,
        ...(active.has(node.status) ? { status: "cancelled", completedAt: thread.updatedAt } : {}),
      });
    for (const subagent of source.subagents)
      event("subagent.updated", subagent.id, {
        ...subagent,
        ...(active.has(subagent.status)
          ? { status: "cancelled", completedAt: thread.updatedAt }
          : {}),
        completionDelivery: undefined,
      });
    for (const provider of source.providerThreads)
      event("provider-thread.updated", provider.id, {
        ...provider,
        providerSessionId: null,
        status: "not_loaded",
        pendingBackgroundTasks: [],
      });
    for (const turn of source.providerTurns)
      event("provider-turn.updated", turn.id, {
        ...turn,
        ...(active.has(turn.status) ? { status: "cancelled", completedAt: thread.updatedAt } : {}),
      });
    for (const message of source.messages)
      event("message.updated", message.id, {
        ...message,
        streaming: false,
        attachments: message.attachments.filter(
          (attachment) => !unavailableAttachments.has(attachmentRelativePath(attachment) ?? ""),
        ),
      });
    for (const item of source.turnItems)
      event("turn-item.updated", item.id, {
        ...item,
        ...(item.type === "assistant_message" ? { streaming: false } : {}),
        ...((item.type === "user_message" || item.type === "assistant_message") &&
        item.attachments !== undefined
          ? {
              attachments: item.attachments.filter(
                (attachment) =>
                  !unavailableAttachments.has(attachmentRelativePath(attachment) ?? ""),
              ),
            }
          : {}),
        ...(active.has(item.status) ? { status: "cancelled", completedAt: thread.updatedAt } : {}),
      });
    for (const plan of source.plans) event("plan.updated", plan.id, plan);
    for (const scope of source.checkpointScopes) event("checkpoint-scope.created", scope.id, scope);
    for (const checkpoint of source.checkpoints)
      event("checkpoint.captured", checkpoint.id, checkpoint);
    for (const handoff of source.contextHandoffs)
      event("context-handoff.updated", handoff.id, {
        ...handoff,
        ...(handoff.status === "pending" ? { status: "superseded" } : {}),
      });
    for (const transfer of source.contextTransfers)
      event("context-transfer.updated", transfer.id, {
        ...transfer,
        ...(transfer.status === "pending" ? { status: "superseded" } : {}),
      });
    if (source.legacyTurnUsage !== undefined)
      event("legacy-usage.imported", thread.id, source.legacyTurnUsage);
    return yield* sink.commitCommand({
      commandId: CommandId.make(`${prefix}:history`),
      commandType: "thread.history.import",
      threadId: thread.id,
      acceptedAt: thread.updatedAt,
      events,
      effects: [],
    });
  });
});
