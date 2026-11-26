import { msg } from "gt-react";
import { ensureClientSettingsHydrated, getClientSettings } from "~/hooks/useSettings";
import { m } from "~/i18n/messages";
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
    await ensureClientSettingsHydrated().catch(() => {});
    if (!getClientSettings().confirmTerminalClose) return true;
    return await localApi.dialogs.confirm(
      labels.length === 1
        ? [
            m(msg('Close terminal "{label}"?', { label: labels[0] })),
            m(msg("This stops the running process and clears its history.")),
          ].join("\n")
        : [
            m(
              msg("Close {count, plural, one {{count} terminal} other {{count} terminals}}?", {
                count: labels.length,
              }),
            ),
            m(
              msg(
                "This stops running processes in {labels} and clears all {count} terminal histories.",
                { labels: activeLabels, count: labels.length },
              ),
            ),
          ].join("\n"),
      { variant: "destructive" },
    );
  } catch {
    return false;
  }
}
