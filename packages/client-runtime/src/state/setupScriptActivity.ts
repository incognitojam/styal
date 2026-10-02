import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

type CommandItem = Extract<OrchestrationV2TurnItem, { type: "command_execution" }>;
export type SetupScriptState = "running" | "completed" | "failed" | "stopped";

function setupScriptActivityState(item: CommandItem): SetupScriptState {
  if (item.status === "pending" || item.status === "running") return "running";
  if (item.status === "completed") return "completed";
  if (item.status === "interrupted" || item.status === "cancelled") return "stopped";
  return "failed";
}

export function setupScriptActivityLabel(item: CommandItem): string {
  const name = item.setupScript?.scriptName.trim() || item.title || "Setup script";
  return `${name} ${setupScriptActivityState(item)}`;
}
