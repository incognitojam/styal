import {
  CommandId,
  EventId,
  TurnId,
  TurnItemId,
  PlanId,
  TURN_USAGE_ACTIVITY_KIND,
  ThreadTokenUsage,
  type IsoDateTime,
  type OrchestrationV2DomainEvent,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ThreadMessageSentPayload,
  OrchestrationEvent,
} from "@t3tools/contracts/legacy-orchestration";
import { deriveTurnUsage, sumThreadTokenUsage } from "@t3tools/shared/turnUsage";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  importedThread,
  messageEvents,
} from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import { legacyHistoricalItems } from "../orchestration-v2/legacy/LegacyHistoricalItems.ts";
import { orderLegacyHistory } from "../orchestration-v2/legacy/orderLegacyHistory.ts";
import { legacyProviderContinuation } from "../orchestration-v2/legacy/LegacyProviderContinuation.ts";
import { createEmptyReadModel, projectEvent } from "./LegacyEventProjection.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export interface HistoricalProviderContinuation {
  readonly threadId: ThreadId;
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly runtimeMode: RuntimeMode;
  readonly lastSeenAt: IsoDateTime;
  readonly resumeCursor: unknown;
}

/** Fold the frozen V1 format, then persist only V2 events and projections. */
export const makeLegacyHistoryWriter = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const commandReceipts = yield* CommandReceiptStore.CommandReceiptStoreV2.pipe(
    Effect.provide(CommandReceiptStore.layer),
  );
  return Effect.fn("LegacyHistoryWriter.write")(function* (
    sourceInput: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
    options?: { readonly continuation?: HistoricalProviderContinuation },
  ) {
    if (sourceInput.length === 0 && options?.continuation === undefined) return;
    const source = yield* Effect.forEach(sourceInput, (event, index) =>
      Schema.decodeUnknownEffect(OrchestrationEvent)({ ...event, sequence: index + 1 }),
    );
    const initialAt = source[0]?.occurredAt ?? options?.continuation?.lastSeenAt;
    if (initialAt === undefined) return;
    let model = createEmptyReadModel(initialAt);
    for (const event of source) model = yield* projectEvent(model, event);
    // Derived prompt links can arrive after the original message event. The
    // frozen upstream V1 projector predates this fork event, so apply its
    // association without changing the message's historical timestamps.
    for (const event of source) {
      if (event.type !== "thread.turn-prompt-linked") continue;
      model = {
        ...model,
        threads: model.threads.map((thread) =>
          thread.id !== event.payload.threadId
            ? thread
            : {
                ...thread,
                messages: thread.messages.map((message) =>
                  message.id === event.payload.messageId
                    ? { ...message, turnId: event.payload.turnId }
                    : message,
                ),
              },
        ),
      };
    }
    const events: OrchestrationV2DomainEvent[] = [];
    const prefix = `import:v1:${source.at(-1)?.eventId ?? options?.continuation?.lastSeenAt}`;
    for (const legacy of model.threads) {
      const thread = importedThread({
        thread_id: legacy.id,
        project_id: legacy.projectId,
        title: legacy.title,
        model_selection_json: encodeJson(legacy.modelSelection),
        runtime_mode: legacy.runtimeMode,
        interaction_mode: legacy.interactionMode,
        branch: legacy.branch,
        worktree_path: legacy.worktreePath,
        created_at: legacy.createdAt,
        updated_at: legacy.updatedAt,
        archived_at: legacy.archivedAt,
        settled_override: legacy.settledOverride,
        settled_at: legacy.settledAt,
        unsettled_at: legacy.unsettledAt ?? null,
        snoozed_until: legacy.snoozedUntil ?? null,
        snoozed_at: legacy.snoozedAt ?? null,
        pinned_at: legacy.pinnedAt ?? null,
        auto_settle_disabled_at: legacy.autoSettleDisabledAt ?? null,
        pin_order_key: legacy.pinOrderKey ?? null,
        active_order_key: legacy.activeOrderKey ?? null,
        deleted_at: legacy.deletedAt,
        pull_requests_json: encodeJson(legacy.pullRequests),
        linked_pull_request_json: encodeJson(legacy.linkedPullRequest ?? null),
        branch_pull_request_json: encodeJson(legacy.branchPullRequest ?? null),
      });
      const historicalItem = (
        id: string,
        ordinal: number,
        createdAt: string,
        updatedAt: string,
      ) => ({
        id: TurnItemId.make(`import:v1:item:${id}`),
        threadId: thread.id,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed" as const,
        title: null,
        startedAt: DateTime.makeUnsafe(createdAt),
        completedAt: DateTime.makeUnsafe(updatedAt),
        updatedAt: DateTime.makeUnsafe(updatedAt),
      });
      events.push({
        id: EventId.make(`${prefix}:thread:${thread.id}`),
        type: "thread.created",
        threadId: thread.id,
        occurredAt: thread.createdAt,
        payload: thread,
      });
      for (const [ordinal, message] of legacy.messages.entries()) {
        if (message.role === "reasoning") {
          events.push({
            id: EventId.make(`${prefix}:reasoning:${message.id}`),
            type: "turn-item.updated",
            threadId: thread.id,
            occurredAt: DateTime.makeUnsafe(message.updatedAt),
            payload: {
              ...historicalItem(message.id, ordinal + 1, message.createdAt, message.updatedAt),
              type: "reasoning",
              text: message.text,
              streaming: false,
            },
          });
          continue;
        }
        if (message.role !== "user" && message.role !== "assistant") continue;
        events.push(
          ...messageEvents({
            message_id: message.id,
            thread_id: thread.id,
            turn_id: message.turnId,
            role: message.role,
            text: message.text,
            attachments_json: encodeJson(message.attachments ?? []),
            ...(message.context === undefined ? {} : { context_json: encodeJson(message.context) }),
            is_streaming: message.streaming ? 1 : 0,
            created_at: message.createdAt,
            updated_at: message.updatedAt,
            ordinal: ordinal + 1,
          }).map((event) => ({ ...event, id: EventId.make(`${prefix}:${event.id}`) })),
        );
      }
      for (const [ordinal, plan] of legacy.proposedPlans.entries()) {
        events.push({
          id: EventId.make(`${prefix}:plan:${plan.id}`),
          type: "turn-item.updated",
          threadId: thread.id,
          occurredAt: DateTime.makeUnsafe(plan.updatedAt),
          payload: {
            ...historicalItem(
              plan.id,
              legacy.messages.length + ordinal + 1,
              plan.createdAt,
              plan.updatedAt,
            ),
            type: "proposed_plan",
            planId: PlanId.make(plan.id),
            markdown: plan.planMarkdown,
            streaming: false,
          },
        });
      }
      events.push(
        ...legacyHistoricalItems({
          legacy,
          thread,
          prefix,
          cwd:
            thread.worktreePath ??
            model.projects.find((project) => project.id === thread.projectId)?.workspaceRoot ??
            "/",
        }),
      );
      // Session sequences restart. Fold usage chronologically, preserving the
      // latest recorded total even when a later model-only record has none.
      const usageActivities = legacy.activities
        .filter((activity) => activity.kind === TURN_USAGE_ACTIVITY_KIND)
        .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
      const usage = deriveTurnUsage(usageActivities);
      const decodeTotal = Schema.decodeUnknownOption(Schema.Struct({ thread: ThreadTokenUsage }));
      let recordedTotal: ThreadTokenUsage | undefined;
      for (const activity of usageActivities) {
        const decoded = decodeTotal(activity.payload);
        if (decoded._tag === "Some") recordedTotal = decoded.value.thread;
      }
      const records = [...usage.byTurnId].map(([turnId, record]) => ({
        turnId: TurnId.make(turnId),
        ...record,
      }));
      const turns = new Set([
        ...legacy.messages.flatMap((message) => (message.turnId === null ? [] : [message.turnId])),
        ...legacy.checkpoints.map((checkpoint) => checkpoint.turnId),
        ...usage.byTurnId.keys(),
      ]).size;
      if (records.length > 0 || turns > 0)
        events.push({
          id: EventId.make(`${prefix}:usage:${thread.id}`),
          type: "legacy-usage.imported",
          threadId: thread.id,
          occurredAt: thread.updatedAt,
          payload: {
            records,
            thread:
              recordedTotal ??
              sumThreadTokenUsage({
                activities: records.map((record) => ({
                  turnId: record.turnId,
                  payload: record.usage,
                })),
                turnId: "import:no-extra-turn",
                usage: null,
                turns,
              }),
          },
        });
    }
    // Retry repairs may contain only corrected prompt links, rather than thread creation.
    for (const event of source) {
      if (
        (event.type !== "thread.message-sent" && event.type !== "thread.turn-prompt-linked") ||
        model.threads.some((thread) => thread.id === event.aggregateId)
      )
        continue;
      const payload =
        event.type === "thread.turn-prompt-linked"
          ? event.payload
          : yield* Schema.decodeUnknownEffect(ThreadMessageSentPayload)(event.payload);
      const projection = yield* projections.getThreadProjection(payload.threadId);
      const message = projection.messages.find((message) => message.id === payload.messageId);
      if (message !== undefined)
        events.push({
          id: EventId.make(`${prefix}:repair-message:${payload.messageId}`),
          type: "message.updated",
          threadId: payload.threadId,
          occurredAt: message.updatedAt,
          payload: {
            ...message,
            ...(payload.turnId === null ? {} : { legacyTurnId: payload.turnId }),
          },
        });
      const item = projection.turnItems.find(
        (item) =>
          (item.type === "user_message" || item.type === "assistant_message") &&
          item.messageId === payload.messageId,
      );
      if (item?.type === "user_message" || item?.type === "assistant_message")
        events.push({
          id: EventId.make(`${prefix}:repair-item:${item.id}`),
          type: "turn-item.updated",
          threadId: payload.threadId,
          occurredAt: item.updatedAt,
          payload: {
            ...item,
            ...(payload.turnId === null ? {} : { legacyTurnId: payload.turnId }),
          },
        });
    }
    if (options?.continuation !== undefined) {
      const sourceContinuation = options.continuation;
      const created = events.find(
        (event) =>
          event.type === "thread.created" && event.threadId === sourceContinuation.threadId,
      );
      const thread =
        created?.type === "thread.created"
          ? created.payload
          : (yield* projections.getThreadProjection(sourceContinuation.threadId)).thread;
      if (thread !== null) {
        const continuation = legacyProviderContinuation({
          thread,
          driver: sourceContinuation.provider,
          instanceId: sourceContinuation.providerInstanceId,
          resumeCursor: sourceContinuation.resumeCursor,
        });
        if (continuation !== null) {
          events.push({
            id: EventId.make(
              `${prefix}:provider:${thread.id}:${continuation.nativeThreadRef?.nativeId}:${continuation.nativeConversationHeadRef?.nativeId}`,
            ),
            type: "provider-thread.updated",
            threadId: thread.id,
            occurredAt: thread.updatedAt,
            payload: continuation,
          });
          events.push({
            id: EventId.make(
              `${prefix}:continuation:${thread.id}:${continuation.nativeThreadRef?.nativeId}:${continuation.nativeConversationHeadRef?.nativeId}`,
            ),
            type: "thread.metadata-updated",
            threadId: thread.id,
            occurredAt: thread.updatedAt,
            payload: { ...thread, activeProviderThreadId: continuation.id },
          });
        }
      }
    }
    // A V1 timeline interleaves messages and work. Preserve that order instead
    // of appending all historical work after the final answer.
    const itemsByThread = new Map<
      ThreadId,
      Extract<OrchestrationV2DomainEvent, { type: "turn-item.updated" }>[]
    >();
    for (const event of events) {
      if (event.type !== "turn-item.updated") continue;
      const items = itemsByThread.get(event.threadId) ?? [];
      items.push(event);
      itemsByThread.set(event.threadId, items);
    }
    const itemOrdinals = new Map<TurnItemId, number>();
    for (const [threadId, items] of itemsByThread) {
      const sorted = items.toSorted(
        (a, b) =>
          DateTime.toEpochMillis(a.payload.startedAt ?? a.occurredAt) -
          DateTime.toEpochMillis(b.payload.startedAt ?? b.occurredAt),
      );
      const updated = sorted.map((event, index) => {
        itemOrdinals.set(event.payload.id, index + 1);
        return { ...event, payload: { ...event.payload, ordinal: index + 1 } };
      });
      itemsByThread.set(threadId, updated);
    }
    for (const [index, event] of events.entries()) {
      if (event.type !== "turn-item.updated") continue;
      events[index] = {
        ...event,
        payload: {
          ...event.payload,
          ordinal: itemOrdinals.get(event.payload.id) ?? event.payload.ordinal,
        },
      };
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const project of model.projects) {
          const commandId = CommandId.make(`${prefix}:project:${project.id}`);
          yield* sink.commitProjectCommand({
            commandId,
            projectId: project.id,
            commandType: "project.create",
            acceptedAt: DateTime.makeUnsafe(project.createdAt),
            event: {
              eventId: EventId.make(commandId),
              type: "project.created",
              aggregateKind: "project",
              aggregateId: project.id,
              occurredAt: project.createdAt,
              commandId,
              causationEventId: null,
              correlationId: commandId,
              metadata: {},
              payload: {
                projectId: project.id,
                title: project.title,
                workspaceRoot: project.workspaceRoot,
                defaultModelSelection: project.defaultModelSelection,
                scripts: project.scripts,
                additionalInstructions: project.additionalInstructions ?? null,
                faviconPath: project.faviconPath ?? null,
                projectIcon: project.projectIcon ?? null,
                createdAt: project.createdAt,
                updatedAt: project.updatedAt,
              },
            },
          });
        }
        const byThread = new Map<ThreadId, OrchestrationV2DomainEvent[]>();
        for (const event of events) {
          const group = byThread.get(event.threadId) ?? [];
          group.push(event);
          byThread.set(event.threadId, group);
        }
        const importSequences = new Map<ThreadId, number>();
        for (const [threadId, items] of itemsByThread) {
          if (
            !events.some((event) => event.threadId === threadId && event.type === "thread.created")
          )
            continue;
          for (const event of items) {
            yield* sql`
            INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
            VALUES (${threadId}, ${event.payload.id}, ${event.payload.ordinal})
            ON CONFLICT(thread_id, turn_item_id) DO NOTHING
          `;
          }
        }
        for (const [threadId, group] of byThread) {
          const last = group.at(-1);
          if (last === undefined) continue;
          const continuation = group.find((event) => event.type === "provider-thread.updated");
          const nativeKey =
            continuation?.type === "provider-thread.updated"
              ? `${continuation.payload.nativeThreadRef?.nativeId}:${continuation.payload.nativeConversationHeadRef?.nativeId}`
              : "messages";
          const result = yield* sink.commitCommand({
            commandId: CommandId.make(`${prefix}:history:${threadId}:${nativeKey}`),
            threadId,
            commandType: "thread.history.import",
            acceptedAt: last.occurredAt,
            events: group,
            effects: [],
          });
          importSequences.set(threadId, result.receipt.resultSequence);
        }
        yield* orderLegacyHistory(sql, [...importSequences.keys()]);
        // Receipts survive event compaction and prevent offering the same repair again.
        for (const event of source) {
          if (event.type !== "thread.turn-prompt-linked") continue;
          const resultSequence = importSequences.get(event.payload.threadId);
          if (resultSequence === undefined) continue;
          yield* commandReceipts.insertIfAbsent({
            commandId: CommandId.make(`import:v1:prompt:${event.eventId}`),
            threadId: event.payload.threadId,
            commandType: "thread.turn-prompt-linked.import",
            acceptedAt: DateTime.makeUnsafe(event.occurredAt),
            resultSequence,
            status: "accepted",
            error: null,
          });
        }
      }),
    );
  });
});
