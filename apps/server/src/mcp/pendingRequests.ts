import {
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpPendingRequest,
  ProviderRequestKind,
  type ThreadId,
  orchestratorMcpPendingApprovalNext,
  orchestratorMcpPendingQuestionNext,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

export const isApprovalRequestKind = Schema.is(ProviderRequestKind);

export function pendingRequestNeedsAttention(request: OrchestrationV2RuntimeRequest) {
  if (request.status !== "pending") return false;
  const capability = request.responseCapability;
  return request.kind === "user_input"
    ? capability.type === "live" ||
        capability.type === "message" ||
        (capability.type === "server" && capability.attention === "input")
    : isApprovalRequestKind(request.kind) &&
        (capability.type === "live" || capability.type === "server");
}

export function describePendingRequests(
  requests: ReadonlyArray<OrchestrationV2RuntimeRequest>,
  turnItems: OrchestrationV2ThreadProjection["turnItems"],
  threadId: ThreadId,
  link: string,
): OrchestratorMcpPendingRequest[] {
  return requests
    .filter(pendingRequestNeedsAttention)
    .toSorted((a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt))
    .map((request) => {
      const item = turnItems.find(
        (item) =>
          (item.type === "user_input_request" || item.type === "approval_request") &&
          item.requestId === request.id,
      );
      const kind = request.kind === "user_input" ? "question" : "approval";
      const text =
        item?.type === "user_input_request"
          ? item.questions
              .map((question) => [question.header, question.question].filter(Boolean).join("\n"))
              .join("\n")
          : item?.type === "approval_request"
            ? [
                item.prompt ??
                  [
                    item.toolName,
                    item.toolInput === undefined ? undefined : JSON.stringify(item.toolInput),
                  ]
                    .filter(Boolean)
                    .join(" "),
                item.reason,
              ]
                .filter(Boolean)
                .join("\n")
            : "";
      return {
        requestId: request.id,
        kind,
        text: text.slice(0, 2000),
        next:
          kind === "question"
            ? orchestratorMcpPendingQuestionNext({ threadId, requestId: request.id })
            : orchestratorMcpPendingApprovalNext({ link }),
      };
    });
}
