import { assert, it } from "@effect/vitest";
import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import {
  deriveLegacyTurnPromptLinks,
  legacyTurnPromptLinkEventId,
  prepareLegacyTurnPromptLinks,
  readLegacyTurnLifecycleEvents,
} from "./LegacyImportTurnPromptLinks.ts";

const threadId = ThreadId.make("thread-imported");
const at = "2026-08-17T11:21:40.000Z";

function turnStart(id: string, messageId: string): OrchestrationEvent {
  return {
    sequence: Number(id.at(-1) ?? 0),
    eventId: EventId.make(id),
    type: "thread.turn-start-requested",
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: at,
    commandId: CommandId.make(`command-${id}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`command-${id}`),
    metadata: {},
    payload: {
      threadId,
      messageId: MessageId.make(messageId),
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: at,
    },
  };
}

function session(id: string, status: "running" | "stopped", turnId: string): OrchestrationEvent {
  return {
    sequence: Number(id.at(-1) ?? 0),
    eventId: EventId.make(id),
    type: "thread.session-set",
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: at,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      session: {
        threadId,
        status,
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "full-access",
        activeTurnId: status === "running" ? TurnId.make(turnId) : null,
        lastError: null,
        updatedAt: at,
      },
    },
  };
}

function assistantMessage(id: string, turnId: string): OrchestrationEvent {
  return {
    sequence: Number(id.at(-1) ?? 0),
    eventId: EventId.make(id),
    type: "thread.message-sent",
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: at,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      messageId: MessageId.make(`message-${id}`),
      role: "assistant",
      text: "Done",
      turnId: TurnId.make(turnId),
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  };
}

it("derives one deterministic link from the first unambiguous running session", () => {
  const links = deriveLegacyTurnPromptLinks([
    turnStart("event-start-1", "message-user"),
    session("event-session-2", "running", "turn-root"),
    session("event-session-3", "running", "turn-root"),
  ]);

  assert.lengthOf(links, 1);
  assert.strictEqual(
    links[0]?.eventId,
    legacyTurnPromptLinkEventId(EventId.make("event-session-2")),
  );
  assert.deepInclude(links[0]?.payload, {
    threadId,
    turnId: TurnId.make("turn-root"),
    messageId: MessageId.make("message-user"),
    sourceTurnStartEventId: EventId.make("event-start-1"),
    sourceSessionEventId: EventId.make("event-session-2"),
  });
});

it("reads only repair fields and skips malformed lifecycle rows independently", () => {
  let invalidRowCount = 0;
  const events = readLegacyTurnLifecycleEvents(
    {
      all: () => [
        {
          sequence: 1,
          eventId: "event-start-legacy",
          threadId,
          type: "thread.turn-start-requested",
          occurredAt: at,
          correlationId: "command-start-legacy",
          payloadJson: JSON.stringify({
            threadId,
            messageId: "message-legacy",
            runtimeMode: "removed-legacy-mode",
            interactionMode: "removed-legacy-mode",
            createdAt: at,
          }),
          metadataJson: "{}",
        },
        {
          sequence: 2,
          eventId: "event-malformed",
          threadId,
          type: "thread.session-set",
          occurredAt: at,
          correlationId: null,
          payloadJson: "{not-json",
          metadataJson: "{}",
        },
        {
          sequence: 3,
          eventId: "event-session-legacy",
          threadId,
          type: "thread.session-set",
          occurredAt: at,
          correlationId: null,
          payloadJson: JSON.stringify({
            threadId,
            session: {
              status: "running",
              providerName: 42,
              runtimeMode: "removed-legacy-mode",
              activeTurnId: "turn-legacy",
              updatedAt: at,
            },
          }),
          metadataJson: "{}",
        },
      ],
    },
    [threadId],
    { onInvalidRow: () => (invalidRowCount += 1) },
  );

  assert.strictEqual(invalidRowCount, 1);
  assert.lengthOf(events, 2);
  assert.deepInclude(deriveLegacyTurnPromptLinks(events)[0]?.payload, {
    turnId: TurnId.make("turn-legacy"),
    messageId: MessageId.make("message-legacy"),
  });
});

it("does not guess when starts overlap", () => {
  const links = deriveLegacyTurnPromptLinks([
    turnStart("event-start-1", "message-one"),
    turnStart("event-start-2", "message-two"),
    session("event-session-3", "running", "turn-root"),
  ]);

  assert.deepStrictEqual(links, []);
});

it("does not reuse a cancelled start for a later session", () => {
  const links = deriveLegacyTurnPromptLinks([
    turnStart("event-start-1", "message-user"),
    session("event-session-2", "stopped", "unused"),
    session("event-session-3", "running", "turn-later"),
  ]);

  assert.deepStrictEqual(links, []);
});

it("preserves the first prompt when a provider reuses its active turn", () => {
  const links = deriveLegacyTurnPromptLinks([
    turnStart("event-start-1", "message-first"),
    session("event-session-2", "running", "turn-root"),
    turnStart("event-start-3", "message-follow-up"),
    session("event-session-4", "running", "turn-root"),
  ]);

  assert.lengthOf(links, 1);
  assert.strictEqual(links[0]?.payload.messageId, MessageId.make("message-first"));
});

it("does not persist links for session-only turns", () => {
  const events = [
    turnStart("event-start-1", "message-session-only"),
    session("event-session-2", "running", "turn-session-only"),
    turnStart("event-start-3", "message-visible"),
    session("event-session-4", "running", "turn-visible"),
    assistantMessage("event-message-5", "turn-visible"),
  ];

  const prepared = prepareLegacyTurnPromptLinks(
    events,
    events.filter(
      (event) =>
        event.type !== "thread.turn-start-requested" && event.type !== "thread.session-set",
    ),
  );
  const links = prepared.filter(
    (event): event is Extract<OrchestrationEvent, { type: "thread.turn-prompt-linked" }> =>
      event.type === "thread.turn-prompt-linked",
  );
  assert.deepStrictEqual(
    links.map((event) => event.payload.turnId),
    [TurnId.make("turn-visible")],
  );
});
