import type {
  RelayAgentActivityAggregateRow,
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { isExpiredAgentActivityState } from "./agentActivityPayloads.ts";

export interface AgentActivityAlert {
  readonly title: string;
  readonly body: string;
}

export const TERMINAL_NOTIFICATION_FRESHNESS_MS = 2 * 60 * 1_000;

export function isFreshTerminalNotification(updatedAt: string, nowMs: number): boolean {
  const timestamp = Option.getOrNull(DateTime.make(updatedAt));
  return (
    timestamp !== null && nowMs - timestamp.epochMilliseconds <= TERMINAL_NOTIFICATION_FRESHNESS_MS
  );
}

type TransitionInput = {
  readonly previousAggregate: RelayAgentActivityAggregateState | null;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly preferences: RelayAgentAwarenessPreferences | null;
};

function rowKey(row: RelayAgentActivityAggregateRow): string {
  return JSON.stringify([row.environmentId, row.threadId]);
}

export function rowPhasesChanged(
  previousAggregate: RelayAgentActivityAggregateState,
  nextAggregate: RelayAgentActivityAggregateState,
): boolean {
  if (previousAggregate.activities.length !== nextAggregate.activities.length) return true;
  const previousPhases = new Map(
    previousAggregate.activities.map((row) => [rowKey(row), row.phase]),
  );
  return nextAggregate.activities.some((row) => previousPhases.get(rowKey(row)) !== row.phase);
}

function isAttentionPhase(phase: string): boolean {
  return phase === "waiting_for_approval" || phase === "waiting_for_input";
}

export function isAlertPhase(phase: string): boolean {
  return isAttentionPhase(phase) || phase === "completed" || phase === "failed";
}

export function attendedAlertDelaySeconds(
  preferences: RelayAgentAwarenessPreferences | null,
): number {
  return preferences?.attendedAlertDelaySeconds ?? 0;
}

/** The delayed alert job owns this alert; the immediate delivery must stay silent. */
function isDelayedWhileAttended(
  preferences: RelayAgentAwarenessPreferences | null,
  row: { readonly attended?: boolean | undefined },
): boolean {
  return row.attended === true && attendedAlertDelaySeconds(preferences) > 0;
}

function alertAllowedNow(
  preferences: RelayAgentAwarenessPreferences | null,
  row: { readonly phase: string; readonly attended?: boolean | undefined },
): boolean {
  return alertAllowedForPhase(preferences, row.phase) && !isDelayedWhileAttended(preferences, row);
}

export function alertAllowedForPhase(
  preferences: RelayAgentAwarenessPreferences | null,
  phase: string,
): boolean {
  if (preferences === null) return true;
  switch (phase) {
    case "waiting_for_approval":
      return preferences.notifyOnApproval;
    case "waiting_for_input":
      return preferences.notifyOnInput;
    case "completed":
      return preferences.notifyOnCompletion;
    case "failed":
      return preferences.notifyOnFailure;
    default:
      return false;
  }
}

// A missing baseline is a replay, not a transition that should buzz the phone.
export function attentionTransitionRows(input: TransitionInput) {
  if (input.previousAggregate === null) return [];
  const previouslyAttention = new Set(
    input.previousAggregate.activities.filter((row) => isAttentionPhase(row.phase)).map(rowKey),
  );
  return input.nextAggregate.activities.filter(
    (row) =>
      isAttentionPhase(row.phase) &&
      !previouslyAttention.has(rowKey(row)) &&
      alertAllowedNow(input.preferences, row),
  );
}

export function newlyTerminalRows(
  previousAggregate: RelayAgentActivityAggregateState | null,
  nextAggregate: RelayAgentActivityAggregateState,
  includeUnobserved = false,
): ReadonlyArray<RelayAgentActivityAggregateRow> {
  if (previousAggregate === null) return [];
  const previousPhases = new Map(
    previousAggregate.activities.map((row) => [rowKey(row), row.phase]),
  );
  return nextAggregate.activities.filter((row) => {
    if (row.phase !== "completed" && row.phase !== "failed") return false;
    const previousPhase = previousPhases.get(rowKey(row));
    return (
      (includeUnobserved || previousPhase !== undefined) &&
      previousPhase !== "completed" &&
      previousPhase !== "failed"
    );
  });
}

export function terminalTransitionRows(
  input: TransitionInput & { readonly nowMs: number; readonly includeUnobserved?: boolean },
) {
  return newlyTerminalRows(
    input.previousAggregate,
    input.nextAggregate,
    input.includeUnobserved,
  ).filter((row) => {
    return (
      alertAllowedNow(input.preferences, row) &&
      isFreshTerminalNotification(row.updatedAt, input.nowMs)
    );
  });
}

export function alertForActivityRows(
  rows: ReadonlyArray<RelayAgentActivityAggregateRow>,
): AgentActivityAlert | null {
  const first = rows[0];
  if (!first) return null;
  if (rows.length === 1) {
    return { title: first.threadTitle, body: `${first.status}: ${first.projectTitle}` };
  }
  return {
    title: `${rows.length} agents ${isAttentionPhase(first.phase) ? "need attention" : "finished"}`,
    body: rows.map((row) => row.threadTitle).join(", "),
  };
}

export function alertForAttentionTransition(input: TransitionInput): AgentActivityAlert | null {
  return alertForActivityRows(attentionTransitionRows(input));
}

export function alertForNewlyTerminal(
  input: TransitionInput & { readonly nowMs: number; readonly includeUnobserved?: boolean },
): AgentActivityAlert | null {
  return alertForActivityRows(terminalTransitionRows(input));
}

export function alertForTerminalAggregate(input: {
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly preferences: RelayAgentAwarenessPreferences | null;
}): AgentActivityAlert | null {
  const row = input.aggregate?.activities[0];
  if (!row || (row.phase !== "completed" && row.phase !== "failed")) return null;
  return alertAllowedNow(input.preferences, row) ? alertForActivityRows([row]) : null;
}

export function shouldAlertForActivity(input: {
  readonly phase: RelayAgentActivityAggregateRow["phase"];
  readonly updatedAt: string;
  readonly attended?: boolean | undefined;
  readonly preferences: RelayAgentAwarenessPreferences | null;
  readonly nowMs: number;
}): boolean {
  return (
    input.preferences?.notificationsEnabled === true &&
    alertAllowedNow(input.preferences, input) &&
    ((input.phase !== "completed" && input.phase !== "failed") ||
      isFreshTerminalNotification(input.updatedAt, input.nowMs))
  );
}

function epochMillis(value: string | undefined): number {
  if (value === undefined) return Number.NaN;
  return Option.match(DateTime.make(value), {
    onNone: () => Number.NaN,
    onSome: (dt) => dt.epochMilliseconds,
  });
}

/**
 * A delayed alert still goes out when the thread is in the phase that raised it and
 * nobody has opened it since. Resolving it or reading it at the computer drops it.
 */
export function delayedAlertIsDue(input: {
  readonly raised: Pick<RelayAgentActivityState, "phase" | "updatedAt">;
  readonly current: RelayAgentActivityState | null;
  readonly preferences: RelayAgentAwarenessPreferences | null;
  readonly nowMs: number;
}): boolean {
  const current = input.current;
  if (
    current === null ||
    current.phase !== input.raised.phase ||
    input.preferences?.notificationsEnabled !== true ||
    !alertAllowedForPhase(input.preferences, current.phase) ||
    isExpiredAgentActivityState(current, input.nowMs)
  ) {
    return false;
  }
  return !(epochMillis(current.lastVisitedAt) >= epochMillis(input.raised.updatedAt));
}
