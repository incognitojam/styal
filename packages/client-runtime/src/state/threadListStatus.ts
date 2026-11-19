import type { EnvironmentThreadShell } from "./models.ts";

/** What a thread list row shows in its status slot, highest precedence first. */
export type ThreadListStatus =
  | "approval"
  | "input"
  | "request"
  | "preparing"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

export type ThreadListStatusInput = Pick<
  EnvironmentThreadShell,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "openReportQuestionCount"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "runtime"
  | "blockedOnThreadWait"
>;

export function resolveThreadListStatus(thread: ThreadListStatusInput): ThreadListStatus {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (
    thread.hasPendingUserInput ||
    (thread.openReportQuestionCount ?? 0) > 0 ||
    thread.pendingSubagentRequest === "user_input"
  ) {
    return "input";
  }
  // A guest is waiting on the owner; the agent's own requests come first.
  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return "request";
  }
  if (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) {
    return "waiting";
  }
  if (thread.runtime?.status === "preparing") {
    return "preparing";
  }
  if (
    thread.runtime !== null &&
    ["queued", "starting", "running", "waiting"].includes(thread.runtime.status)
  ) {
    return "working";
  }
  if (thread.runtime?.status === "idle") {
    return "waiting";
  }
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return "ready";
}
