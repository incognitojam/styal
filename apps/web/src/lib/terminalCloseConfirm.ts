import { readLocalApi } from "~/localApi";

let pendingConfirmationFlows = 0;

export interface TerminalCloseTarget {
  readonly terminalId: string;
  readonly label: string;
}

export function resolveTerminalCloseConfirmationIds(
  targets: readonly TerminalCloseTarget[],
  preflightTerminalIds: readonly string[] | null,
): ReadonlySet<string> {
  return new Set(preflightTerminalIds ?? targets.map(({ terminalId }) => terminalId));
}

/** Whether a terminal-close preflight or confirmation is currently pending. */
export function isTerminalCloseConfirmPending(): boolean {
  return pendingConfirmationFlows > 0;
}

/**
 * Run one terminal-close confirmation flow at a time. The guard is acquired
 * before the first await so rapid clicks and keypresses cannot queue duplicate
 * preflights or dialogs.
 */
export async function runTerminalCloseConfirmationFlow(
  flow: () => Promise<boolean>,
): Promise<boolean> {
  if (pendingConfirmationFlows > 0) return false;

  pendingConfirmationFlows += 1;
  try {
    return await flow();
  } catch {
    return false;
  } finally {
    pendingConfirmationFlows -= 1;
  }
}

/**
 * Confirmation for individual terminal close actions: drawer buttons, panel
 * buttons, the `terminal.close` keybinding, and closing a terminal surface from
 * the tab strip. Auto-exit cleanup and bulk tab closes skip this path and close
 * directly.
 */
export async function confirmTerminalClose(
  targets: readonly [TerminalCloseTarget, ...TerminalCloseTarget[]],
  confirmationTerminalIds: ReadonlySet<string>,
): Promise<boolean> {
  const activeTargets = targets.filter(({ terminalId }) => confirmationTerminalIds.has(terminalId));
  if (activeTargets.length === 0) return true;

  const localApi = readLocalApi();
  if (!localApi) return true;
  const labels = targets.map(({ label }) => label);
  const activeLabels = activeTargets.map(({ label }) => `"${label}"`).join(", ");
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
  }
}
