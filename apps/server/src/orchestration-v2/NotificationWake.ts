import type {
  MessageId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ProjectionStore from "./ProjectionStore.ts";

export const isStaleQuestionWake = Effect.fn("NotificationWake.isStaleQuestion")(function* (
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "subagents">,
  messageId: MessageId,
  notification: OrchestrationV2ConversationMessage["notification"],
) {
  if (
    notification?.source.kind !== "delegated_task" ||
    notification.outcome !== "updated" ||
    notification.source.childThreadId === undefined
  )
    return false;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const source = notification.source;
  const threadId = projection.thread.id;
  const task =
    projection.subagents.find((candidate) => source.taskIds.includes(candidate.id)) ??
    // Command projections omit settled tasks whose result was already handed over.
    (yield* projections.getThreadRecords(threadId, ["subagents"], { subagentIds: source.taskIds }))
      .subagents[0];
  // An unknown task gives no evidence the question is obsolete.
  if (task === undefined) return false;
  if (
    task.childThreadId === null ||
    ["completed", "failed", "cancelled", "interrupted"].includes(task.status)
  )
    return true;
  const child = yield* projections.getThreadRecords(task.childThreadId, ["runtimeRequests"]);
  return !child.runtimeRequests.some(
    (request) =>
      request.kind === "user_input" &&
      request.status === "pending" &&
      messageId === `message:delegated-task-question:${threadId}:${request.id}`,
  );
});

export const isStaleRestartNotificationWake = Effect.fn("NotificationWake.isStaleAtRestart")(
  function* (
    projection: Pick<OrchestrationV2ThreadProjection, "thread" | "subagents">,
    messageId: MessageId,
    notification: OrchestrationV2ConversationMessage["notification"],
  ) {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    if (notification?.source.kind === "delegated_task")
      return yield* isStaleQuestionWake(projection, messageId, notification);
    if (notification?.source.kind !== "launched_thread" || notification.outcome !== "updated")
      return false;
    const childId = notification.source.childThreadId;
    const prefix = `message:thread-report:${childId}:`;
    if (!messageId.startsWith(prefix)) return false;
    const key = messageId.slice(prefix.length);
    const source = yield* projections.getThreadRecords(childId, ["runtimeRequests"]);
    return source.runtimeRequests.some(
      (request) => request.id === key && request.status === "resolved",
    );
  },
);
