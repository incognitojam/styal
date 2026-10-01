import type { OrchestrationThreadActivity } from "@t3tools/contracts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function toolStartKey(turnId: string | null | undefined, toolCallId: string): string {
  return `${turnId ?? ""}\u0000${toolCallId}`;
}

/**
 * Finds when each tool call started so its work log row can sit there: the
 * earliest of its `tool.started` and `tool.updated` rows, or the `startedAt`
 * the server moves onto a completion when a snapshot drops those rows. A call
 * that completes late (a dev server left running, a provider that batches
 * completions) would otherwise land after the turn's answer or a later user
 * message. Returns the start for a row's turn and tool call id, if earlier
 * than `createdAt`.
 */
export function makeToolStartLookup(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  const startByKey = new Map<string, string>();
  for (const activity of activities) {
    if (!activity.kind.startsWith("tool.")) continue;
    const payload = record(activity.payload);
    const toolCallId =
      nonEmptyString(payload?.toolCallId) ?? nonEmptyString(record(payload?.data)?.toolCallId);
    if (!toolCallId) continue;
    const startedAt =
      activity.kind === "tool.completed"
        ? nonEmptyString(payload?.startedAt)
        : activity.kind === "tool.started" || activity.kind === "tool.updated"
          ? activity.createdAt
          : undefined;
    if (!startedAt) continue;
    const key = toolStartKey(activity.turnId, toolCallId);
    const known = startByKey.get(key);
    if (known === undefined || startedAt < known) startByKey.set(key, startedAt);
  }
  return (entry: {
    readonly turnId?: string | null | undefined;
    readonly toolCallId?: string | undefined;
    readonly createdAt: string;
  }): string | undefined => {
    if (!entry.toolCallId) return undefined;
    const startedAt = startByKey.get(toolStartKey(entry.turnId, entry.toolCallId));
    return startedAt !== undefined && startedAt < entry.createdAt ? startedAt : undefined;
  };
}
