import {
  OrchestrationV2ProviderThread,
  ProviderThreadId,
  type OrchestrationV2AppThread,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { serverNameForResumeCursor } from "../../mcp/McpProviderSession.ts";

/** Translate durable V1 conversation identifiers without reviving a live session. */
export function legacyProviderContinuation(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly resumeCursor: unknown;
}): OrchestrationV2ProviderThread | null {
  const cursor = input.resumeCursor;
  if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return null;
  const values = cursor as Record<string, unknown>;
  const string = (key: string) => {
    const value = values[key];
    return typeof value === "string" && value.trim() !== "" ? value : null;
  };
  const nativeId =
    input.driver === "codex"
      ? string("threadId")
      : input.driver === "claudeAgent"
        ? (string("resume") ?? string("threadId"))
        : ["cursor", "grok", "opencode"].includes(input.driver)
          ? string("sessionId")
          : null;
  if (nativeId === null) return null;
  const head = input.driver === "claudeAgent" ? string("resumeSessionAt") : null;
  const ref = (nativeId: string) => ({
    driver: input.driver,
    nativeId,
    strength: "strong" as const,
  });
  return {
    id: ProviderThreadId.make(`migration:v1:provider-thread:${input.thread.id}`),
    driver: input.driver,
    providerInstanceId: input.instanceId,
    providerSessionId: null,
    appThreadId: input.thread.id,
    ownerNodeId: null,
    nativeThreadRef: ref(nativeId),
    nativeConversationHeadRef: head === null ? null : ref(head),
    status: "not_loaded",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    nativeMetadata: { mcpServerName: serverNameForResumeCursor(cursor, true) },
    createdAt: input.thread.createdAt,
    updatedAt: input.thread.updatedAt,
  };
}
