import type { TerminalSessionState } from "@t3tools/client-runtime/state/terminal";
import { readLocalApi } from "~/localApi";

let pendingConfirmations = 0;

export type TerminalCloseState = Pick<
  TerminalSessionState,
  "status" | "hasRunningSubprocess"
>;

export interface TerminalCloseTarget {
  readonly terminalId: string;
  readonly label: string;
  readonly state: TerminalCloseState | null;
}

function hasActiveWork({ terminalId, state }: TerminalCloseTarget): boolean {
  // An interactive shell remains "running" while idle, whereas setup terminals
  // run one finite command as the root PTY process and may have no child subprocess.
  return (
    state?.hasRunningSubprocess === true ||
    (terminalId.startsWith("setup-") &&
      (state?.status === "starting" || state?.status === "running"))
  );
}

/** Whether a terminal-close confirmation is currently waiting on the user. */
export function isTerminalCloseConfirmPending(): boolean {
  return pendingConfirmations > 0;
}

/**
 * Confirmation for individual terminal close actions: drawer buttons, panel
 * buttons, the `terminal.close` keybinding, and closing a terminal surface from
 * the tab strip. Auto-exit cleanup and bulk tab closes skip this path and close
 * directly.
 */
export async function confirmTerminalClose(
  targets: readonly [TerminalCloseTarget, ...TerminalCloseTarget[]],
): Promise<boolean> {
  const activeTargets = targets.filter(hasActiveWork);
  if (activeTargets.length === 0) return true;

  const localApi = readLocalApi();
  if (!localApi) return true;
  const labels = targets.map(({ label }) => label);
  const activeLabels = activeTargets.map(({ label }) => `"${label}"`).join(", ");
  pendingConfirmations += 1;
  try {
    return await localApi.dialogs.confirm(
      labels.length === 1
        ? [
            `Close terminal "${labels[0]}"?`,
            "This stops the running process and clears its history.",
          ].join("\n")
        : [
            `Close ${labels.length} terminals?`,
            `This stops running processes in ${activeLabels} and clears all ${labels.length} terminal histories.`,
          ].join("\n"),
      { variant: "destructive" },
    );
  } catch {
    return false;
  } finally {
    pendingConfirmations -= 1;
  }
}
