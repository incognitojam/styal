import type { SidebarThreadTimestampMode } from "@t3tools/contracts/settings";

export function resolveThreadDisplayTimestamp(
  thread: {
    latestMessageAt?: string | null | undefined;
    latestUserMessageAt?: string | null | undefined;
    updatedAt?: string | null | undefined;
    createdAt: string;
  },
  mode: SidebarThreadTimestampMode,
): string {
  if (mode === "last_message") {
    // Older servers do not send latestMessageAt; updatedAt is their closest
    // available signal for a reply, though it can include other activity.
    return (
      thread.latestMessageAt ?? thread.updatedAt ?? thread.latestUserMessageAt ?? thread.createdAt
    );
  }
  return thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt;
}
