import {
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationEvent,
  OrchestrationEventMetadata,
  OrchestrationProposedPlanId,
  OrchestrationSessionStatus,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

type TurnStartEvent = Extract<OrchestrationEvent, { readonly type: "thread.turn-start-requested" }>;
type TurnPromptLinkedEvent = Extract<
  OrchestrationEvent,
  { readonly type: "thread.turn-prompt-linked" }
>;

interface LegacyEventDatabase {
  readonly all: (sql: string, parameters?: ReadonlyArray<string>) => unknown;
}

type LifecycleEventBase = Pick<
  TurnStartEvent,
  "sequence" | "eventId" | "occurredAt" | "correlationId" | "metadata"
>;
type CompactTurnStartEvent = LifecycleEventBase & {
  readonly type: "thread.turn-start-requested";
  readonly payload: Pick<
    TurnStartEvent["payload"],
    "threadId" | "messageId" | "sourceProposedPlan" | "createdAt"
  >;
};
type SessionSetEvent = Extract<OrchestrationEvent, { readonly type: "thread.session-set" }>;
type CompactSessionSetEvent = LifecycleEventBase & {
  readonly type: "thread.session-set";
  readonly payload: {
    readonly threadId: SessionSetEvent["payload"]["threadId"];
    readonly session: Pick<
      SessionSetEvent["payload"]["session"],
      "status" | "activeTurnId" | "updatedAt"
    >;
  };
};
type CompactLifecycleEvent = CompactTurnStartEvent | CompactSessionSetEvent;
type TurnStartSourceEvent = TurnStartEvent | CompactTurnStartEvent;

const LifecycleEventRow = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: EventId,
  type: Schema.Literals(["thread.turn-start-requested", "thread.session-set"]),
  occurredAt: IsoDateTime,
  correlationId: Schema.NullOr(CommandId),
  payloadJson: Schema.String,
  metadataJson: Schema.String,
});
const CompactTurnStartPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  sourceProposedPlan: Schema.optional(
    Schema.Struct({
      threadId: ThreadId,
      planId: OrchestrationProposedPlanId,
    }),
  ),
  createdAt: IsoDateTime,
});
const CompactSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  session: Schema.Struct({
    status: OrchestrationSessionStatus,
    activeTurnId: Schema.NullOr(TurnId),
    updatedAt: IsoDateTime,
  }),
});
const decodeUnknownRows = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown));
const decodeLifecycleEventRow = Schema.decodeUnknownOption(LifecycleEventRow);
const decodeTurnStartPayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(CompactTurnStartPayload),
);
const decodeSessionSetPayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(CompactSessionSetPayload),
);
const decodeEventMetadata = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationEventMetadata),
);

/**
 * Read only the lifecycle fields needed to derive prompt links. A malformed
 * row is isolated from the rest of the preview instead of invalidating it.
 */
export function readLegacyTurnLifecycleEvents(
  database: LegacyEventDatabase,
  threadIds: ReadonlyArray<ThreadId>,
  options: { readonly onInvalidRow?: () => void } = {},
): ReadonlyArray<CompactLifecycleEvent> {
  if (threadIds.length === 0) return [];
  const events: CompactLifecycleEvent[] = [];
  for (let offset = 0; offset < threadIds.length; offset += 500) {
    const batch = threadIds.slice(offset, offset + 500);
    const rows = decodeUnknownRows(
      database.all(
        `
        SELECT
          sequence,
          event_id AS eventId,
          event_type AS type,
          occurred_at AS occurredAt,
          correlation_id AS correlationId,
          payload_json AS payloadJson,
          metadata_json AS metadataJson
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND event_type IN ('thread.turn-start-requested', 'thread.session-set')
          AND stream_id IN (${batch.map(() => "?").join(", ")})
        ORDER BY sequence ASC
      `,
        batch,
      ),
    );
    for (const rawRow of rows) {
      const decodedRow = decodeLifecycleEventRow(rawRow);
      if (Option.isNone(decodedRow)) {
        options.onInvalidRow?.();
        continue;
      }
      const { payloadJson, metadataJson, ...eventBase } = decodedRow.value;
      const metadata = Option.getOrElse(decodeEventMetadata(metadataJson), () => ({}));
      if (eventBase.type === "thread.turn-start-requested") {
        const payload = decodeTurnStartPayload(payloadJson);
        if (Option.isNone(payload)) {
          options.onInvalidRow?.();
          continue;
        }
        events.push({ ...eventBase, type: eventBase.type, payload: payload.value, metadata });
        continue;
      }
      const payload = decodeSessionSetPayload(payloadJson);
      if (Option.isNone(payload)) {
        options.onInvalidRow?.();
        continue;
      }
      events.push({ ...eventBase, type: eventBase.type, payload: payload.value, metadata });
    }
  }
  return events.toSorted((left, right) => left.sequence - right.sequence);
}

export function legacyTurnPromptLinkEventId(sourceSessionEventId: EventId): EventId {
  return EventId.make(`legacy-import:turn-prompt-link:${sourceSessionEventId}`);
}

/**
 * Derive prompt-to-root-turn provenance only when the source lifecycle makes
 * the association unambiguous. Starts that overlap or never reach a running
 * session are intentionally left unresolved rather than guessed.
 */
export function deriveLegacyTurnPromptLinks(
  events: ReadonlyArray<OrchestrationEvent | CompactLifecycleEvent>,
): ReadonlyArray<TurnPromptLinkedEvent> {
  const pendingStarts = new Map<ThreadId, ReadonlyArray<TurnStartSourceEvent>>();
  const linkedTurnIds = new Map<ThreadId, Set<string>>();
  const links: TurnPromptLinkedEvent[] = [];

  for (const event of events) {
    if (event.type === "thread.turn-start-requested") {
      pendingStarts.set(event.payload.threadId, [
        ...(pendingStarts.get(event.payload.threadId) ?? []),
        event,
      ]);
      continue;
    }
    if (event.type !== "thread.session-set") continue;

    const { session, threadId } = event.payload;
    if (session.status === "running" && session.activeTurnId !== null) {
      const starts = pendingStarts.get(threadId) ?? [];
      pendingStarts.delete(threadId);
      if (starts.length !== 1) continue;

      const start = starts[0];
      if (start === undefined) continue;
      const threadLinkedTurnIds = linkedTurnIds.get(threadId) ?? new Set<string>();
      if (threadLinkedTurnIds.has(session.activeTurnId)) continue;
      threadLinkedTurnIds.add(session.activeTurnId);
      linkedTurnIds.set(threadId, threadLinkedTurnIds);
      links.push({
        sequence: event.sequence,
        eventId: legacyTurnPromptLinkEventId(event.eventId),
        type: "thread.turn-prompt-linked",
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: event.occurredAt,
        commandId: null,
        causationEventId: start.eventId,
        correlationId: start.correlationId,
        metadata: event.metadata,
        payload: {
          threadId,
          turnId: session.activeTurnId,
          messageId: start.payload.messageId,
          requestedAt: start.payload.createdAt,
          startedAt: session.updatedAt,
          sourceTurnStartEventId: start.eventId,
          sourceSessionEventId: event.eventId,
          ...(start.payload.sourceProposedPlan === undefined
            ? {}
            : { sourceProposedPlan: start.payload.sourceProposedPlan }),
        },
      });
      continue;
    }

    if (
      session.status === "error" ||
      session.status === "stopped" ||
      session.status === "interrupted"
    ) {
      pendingStarts.delete(threadId);
    }
  }

  return links;
}

function materializedTurnIdsByThread(
  events: ReadonlyArray<OrchestrationEvent>,
): ReadonlyMap<ThreadId, ReadonlySet<string>> {
  const turnsByThread = new Map<
    ThreadId,
    Map<string, { readonly checkpointTurnCount: number | null }>
  >();
  const turnsFor = (threadId: ThreadId) => {
    const existing = turnsByThread.get(threadId);
    if (existing !== undefined) return existing;
    const turns = new Map<string, { readonly checkpointTurnCount: number | null }>();
    turnsByThread.set(threadId, turns);
    return turns;
  };

  for (const event of events) {
    switch (event.type) {
      case "thread.message-sent":
        if (event.payload.role === "assistant" && event.payload.turnId !== null) {
          const turns = turnsFor(event.payload.threadId);
          if (!turns.has(event.payload.turnId)) {
            turns.set(event.payload.turnId, { checkpointTurnCount: null });
          }
        }
        break;
      case "thread.turn-diff-completed":
        turnsFor(event.payload.threadId).set(event.payload.turnId, {
          checkpointTurnCount: event.payload.checkpointTurnCount,
        });
        break;
      case "thread.reverted": {
        const turns = turnsFor(event.payload.threadId);
        for (const [turnId, turn] of turns) {
          if (
            turn.checkpointTurnCount === null ||
            turn.checkpointTurnCount > event.payload.turnCount
          ) {
            turns.delete(turnId);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return new Map(
    Array.from(turnsByThread, ([threadId, turns]) => [threadId, new Set(turns.keys())]),
  );
}

/**
 * Replace operational lifecycle events with inert, source-backed links.
 * Links are appended after source history so their concrete turn rows exist.
 */
export function prepareLegacyTurnPromptLinks(
  sourceEvents: ReadonlyArray<OrchestrationEvent>,
  retainedEvents: ReadonlyArray<OrchestrationEvent>,
): ReadonlyArray<OrchestrationEvent> {
  const materializedTurnIds = materializedTurnIdsByThread(retainedEvents);
  return [
    ...retainedEvents,
    ...deriveLegacyTurnPromptLinks(sourceEvents).filter((event) =>
      materializedTurnIds.get(event.payload.threadId)?.has(event.payload.turnId),
    ),
  ];
}
