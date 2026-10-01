import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

/** What the lookup reads from a background task's exit row. */
export interface BackgroundExitEntry {
  readonly turnId?: TurnId | null | undefined;
  readonly createdAt: string;
  readonly toolLifecycleStatus?: string | undefined;
}

/**
 * Finds the turn where a background task's exit also gets its own work log
 * row, beside the outcome its launch row already shows, and the status that
 * row reports. That is the turn the
 * agent learns about the exit in: the turn it arrived during, or, when it
 * arrived while the agent was idle, the next turn to start (Claude wakes the
 * agent with the result). Exits in their launch turn, stops, and idle exits no
 * turn has followed yet get no row of their own.
 */
export function makeBackgroundExitTurnLookup(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
) {
  const turnActivities = activities.filter(
    (activity): activity is OrchestrationThreadActivity & { turnId: TurnId } =>
      activity.turnId !== null,
  );
  return (
    exit: BackgroundExitEntry,
    launchTurnId: TurnId | null | undefined,
  ): { readonly turnId: TurnId; readonly status: "completed" | "failed" } | undefined => {
    const status = exit.toolLifecycleStatus;
    if (status !== "completed" && status !== "failed") return undefined;
    if (exit.turnId) {
      return exit.turnId !== launchTurnId ? { turnId: exit.turnId, status } : undefined;
    }
    let next: (OrchestrationThreadActivity & { turnId: TurnId }) | undefined;
    for (const activity of turnActivities) {
      if (activity.createdAt <= exit.createdAt || activity.turnId === launchTurnId) continue;
      if (next === undefined || activity.createdAt < next.createdAt) next = activity;
    }
    return next ? { turnId: next.turnId, status } : undefined;
  };
}
