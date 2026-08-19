import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export type SetupScriptState = "running" | "completed" | "failed" | "stopped";

export function setupScriptActivityState(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | null,
): SetupScriptState | undefined {
  if (activity.kind === "setup-script.requested" || activity.kind === "setup-script.started") {
    return "running";
  }
  if (activity.kind === "setup-script.completed") return "completed";
  if (activity.kind !== "setup-script.failed") return undefined;
  const failureReason = payload?.failureReason;
  if (
    failureReason === "server-restarted" ||
    failureReason === "terminal-closed" ||
    failureReason === "terminal-restarted"
  ) {
    return "stopped";
  }
  // Older activities described an interrupted run in the server-authored
  // summary before they carried a structured failure reason.
  if (activity.summary.toLowerCase().includes("stopped")) return "stopped";
  return "failed";
}

export function setupScriptActivityLabel(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | null,
): string {
  if (!activity.kind.startsWith("setup-script.")) return activity.summary;
  const scriptName = typeof payload?.scriptName === "string" ? payload.scriptName.trim() : "";
  if (!scriptName) return activity.summary;
  const state = setupScriptActivityState(activity, payload);
  if (state === "running") return `${scriptName} running`;
  if (state === "completed") return `${scriptName} completed`;
  if (state === "stopped") return `${scriptName} stopped`;
  if (payload?.failureReason === "launch-error") {
    return `${scriptName} failed to start`;
  }
  return `${scriptName} failed`;
}
