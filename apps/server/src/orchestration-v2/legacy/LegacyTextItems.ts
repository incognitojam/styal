import {
  EventId,
  PlanId,
  TurnItemId,
  type ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

export function legacyTextItem(input: {
  id: string;
  eventId: string;
  threadId: ThreadId;
  ordinal: number;
  createdAt: string;
  updatedAt: string;
  turnId: string | null;
  content:
    | { type: "reasoning"; text: string }
    | { type: "proposed_plan"; planId: string; markdown: string };
}): OrchestrationV2DomainEvent[] {
  const content = input.content;
  if (!(content.type === "reasoning" ? content.text : content.markdown).trim()) return [];
  return [
    {
      id: EventId.make(input.eventId),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: DateTime.makeUnsafe(input.updatedAt),
      payload: {
        id: TurnItemId.make(input.id),
        threadId: input.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: input.ordinal,
        status: "completed",
        title: null,
        startedAt: DateTime.makeUnsafe(input.createdAt),
        completedAt: DateTime.makeUnsafe(input.updatedAt),
        updatedAt: DateTime.makeUnsafe(input.updatedAt),
        ...(input.turnId === null ? {} : { legacyTurnId: input.turnId }),
        ...(content.type === "proposed_plan"
          ? { ...content, planId: PlanId.make(content.planId) }
          : content),
        streaming: false,
      },
    },
  ];
}

const decodePlan = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      proposedPlan: Schema.Struct({
        id: Schema.String,
        turnId: Schema.NullOr(Schema.String),
        planMarkdown: Schema.String,
        createdAt: Schema.String,
        updatedAt: Schema.String,
      }),
    }),
  ),
);

export const readLegacyTextItems = Effect.fn("readLegacyTextItems")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const reasoning = yield* sql<{
    readonly message_id: string;
    readonly turn_id: string | null;
    readonly text: string;
    readonly created_at: string;
    readonly updated_at: string;
  }>`
    SELECT message_id, turn_id, text, created_at, updated_at
    FROM projection_thread_messages WHERE thread_id = ${threadId} AND role = 'reasoning'
    ORDER BY created_at, message_id
  `;
  const plans = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM (
      SELECT payload_json, sequence, ROW_NUMBER() OVER (
        PARTITION BY json_extract(payload_json, '$.proposedPlan.id') ORDER BY sequence DESC
      ) AS rank
      FROM orchestration_events
      WHERE application_event_version = 1 AND aggregate_kind = 'thread'
        AND stream_id = ${threadId} AND event_type = 'thread.proposed-plan-upserted'
    ) WHERE rank = 1 ORDER BY sequence
  `;
  const events = reasoning.flatMap((row, index) =>
    legacyTextItem({
      id: `migration:v1:turn-item:reasoning:${row.message_id}`,
      eventId: `migration:v1:history:${threadId}:reasoning:${row.message_id}`,
      threadId,
      ordinal: index + 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      turnId: row.turn_id,
      content: { type: "reasoning", text: row.text },
    }),
  );
  for (const [index, row] of plans.entries()) {
    const { proposedPlan: plan } = yield* decodePlan(row.payload_json);
    events.push(
      ...legacyTextItem({
        id: `migration:v1:turn-item:plan:${plan.id}`,
        eventId: `migration:v1:history:${threadId}:plan:${plan.id}`,
        threadId,
        ordinal: reasoning.length + index + 1,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
        turnId: plan.turnId,
        content: { type: "proposed_plan", planId: plan.id, markdown: plan.planMarkdown },
      }),
    );
  }
  return events;
});
