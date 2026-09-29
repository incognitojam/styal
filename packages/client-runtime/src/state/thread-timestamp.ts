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
  return (
    (mode === "last_message" ? thread.latestMessageAt : thread.latestUserMessageAt) ??
    thread.latestUserMessageAt ??
    thread.updatedAt ??
    thread.createdAt
  );
}
