import { readLocalApi } from "~/localApi";

const pendingTerminalIdsByThread = new Map<string, Set<string>>();

export interface TerminalCloseTarget {
  readonly terminalId: string;
  readonly label: string;
}

export interface TerminalCloseConfirmationScope {
  readonly environmentId: string;
  readonly threadId: string;
  readonly terminalIds: readonly [string, ...string[]];
}

export interface TerminalCloseConfirmationQuery {
  readonly environmentId: string;
  readonly threadId: string;
  readonly terminalIds?: readonly string[];
}

function terminalCloseThreadKey(scope: TerminalCloseConfirmationQuery): string {
  return JSON.stringify([scope.environmentId, scope.threadId]);
}

export function resolveTerminalCloseConfirmationIds(
  targets: readonly TerminalCloseTarget[],
  preflightTerminalIds: readonly string[] | null,
): ReadonlySet<string> {
  return new Set(preflightTerminalIds ?? targets.map(({ terminalId }) => terminalId));
}

/** Whether a matching terminal-close preflight or confirmation is pending. */
export function isTerminalCloseConfirmPending(query?: TerminalCloseConfirmationQuery): boolean {
  if (!query) return pendingTerminalIdsByThread.size > 0;

  const pendingTerminalIds = pendingTerminalIdsByThread.get(terminalCloseThreadKey(query));
  if (!pendingTerminalIds) return false;
  if (!query.terminalIds) return true;
  return query.terminalIds.some((terminalId) => pendingTerminalIds.has(terminalId));
}

/**
 * Run at most one close-confirmation flow per terminal. Keys are acquired
 * before the first await so matching clicks and keypresses cannot queue
 * duplicate preflights or dialogs, while unrelated terminals remain closable.
 */
export async function runTerminalCloseConfirmationFlow(
  scope: TerminalCloseConfirmationScope,
  flow: () => Promise<boolean>,
): Promise<boolean> {
  const threadKey = terminalCloseThreadKey(scope);
  const terminalIds = [...new Set(scope.terminalIds)];
  const existingTerminalIds = pendingTerminalIdsByThread.get(threadKey);
  if (
    existingTerminalIds &&
    terminalIds.some((terminalId) => existingTerminalIds.has(terminalId))
  ) {
    return false;
  }

  const pendingTerminalIds = existingTerminalIds ?? new Set<string>();
  for (const terminalId of terminalIds) pendingTerminalIds.add(terminalId);
  pendingTerminalIdsByThread.set(threadKey, pendingTerminalIds);
  try {
    return await flow();
  } catch {
    return false;
  } finally {
    for (const terminalId of terminalIds) pendingTerminalIds.delete(terminalId);
    if (pendingTerminalIds.size === 0) pendingTerminalIdsByThread.delete(threadKey);
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
