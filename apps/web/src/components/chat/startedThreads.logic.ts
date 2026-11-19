import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { resolveSidebarThreadStatus } from "../Sidebar.logic";

/**
 * What the project chat's list of started threads says about one: still working, or waiting on
 * you. Null once it has finished or failed: those belong to the page's other lists.
 */
export function startedThreadState(
  thread: EnvironmentThreadShell | null,
): "working" | "needs-you" | null {
  if (thread === null || thread.archivedAt !== null) return null;
  switch (resolveSidebarThreadStatus(thread)) {
    case "approval":
    case "input":
    case "request":
      return "needs-you";
    case "preparing":
    case "working":
      return "working";
    case "waiting":
      // Waiting on another thread is work in progress; an idle session has finished its turn.
      return thread.runtime?.status === "running" ? "working" : null;
    default:
      return null;
  }
}
