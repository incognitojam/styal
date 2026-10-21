import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

type CommandItem = Extract<OrchestrationV2TurnItem, { type: "command_execution" }>;
export type SetupScriptState = "running" | "completed" | "failed" | "stopped" | "needs approval";

/** A styal.json action that asked to run on its own and waits for its command to be approved. */
export function setupScriptAwaitingApproval(item: CommandItem): boolean {
  return item.setupScript?.awaitingApproval !== undefined && item.status === "idle";
}

function setupScriptActivityState(item: CommandItem): SetupScriptState {
  if (setupScriptAwaitingApproval(item)) return "needs approval";
  if (item.status === "pending" || item.status === "running") return "running";
  if (item.status === "completed") return "completed";
  if (item.status === "interrupted" || item.status === "cancelled") return "stopped";
  return "failed";
}

export function setupScriptActivityLabel(item: CommandItem): string {
  const name = item.setupScript?.scriptName.trim() || item.title || "Setup script";
  return `${name} ${setupScriptActivityState(item)}`;
}
