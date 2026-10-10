/**
 * Reads `turn.usage` activities for the token count under each agent turn and
 * the thread total in the composer, and formats them identically on web and
 * mobile. The server uses {@link sumThreadTokenUsage} to write that total.
 *
 * @module turnUsage
 */
import {
  ThreadTokenUsage,
  TURN_USAGE_ACTIVITY_KIND,
  TurnTokenUsage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { formatPercent, formatTokens } from "./usageFormat.ts";

const decodeTurnTokenUsage = Schema.decodeUnknownOption(TurnTokenUsage);
const decodeThreadTokenUsage = Schema.decodeUnknownOption(
  Schema.Struct({ thread: ThreadTokenUsage }),
);

export interface TurnUsageByTurn {
  /** Ids of the usage activities this was derived from. */
  readonly key: string;
  readonly byTurnId: ReadonlyMap<string, TurnTokenUsage>;
  /** The thread total carried by the newest usage record, if it has one. */
  readonly thread: ThreadTokenUsage | null;
}

export const EMPTY_TURN_USAGE: TurnUsageByTurn = { key: "", byTurnId: new Map(), thread: null };

/**
 * Collects usage by turn. Returns `previous` unchanged while the thread gains
 * no usage activities, so views keyed on its identity skip streamed updates.
 */
export function deriveTurnUsage(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  previous: TurnUsageByTurn = EMPTY_TURN_USAGE,
): TurnUsageByTurn {
  const usageActivities = activities.filter(
    (activity) => activity.kind === TURN_USAGE_ACTIVITY_KIND && activity.turnId !== null,
  );
  const key = usageActivities.map((activity) => activity.id).join(",");
  if (key === previous.key) return previous;

  const byTurnId = new Map<string, TurnTokenUsage>();
  let newest: OrchestrationThreadActivity | undefined;
  for (const activity of usageActivities) {
    const usage = Option.getOrNull(decodeTurnTokenUsage(activity.payload));
    if (usage !== null && activity.turnId !== null) byTurnId.set(activity.turnId, usage);
    // Activities are ordered by provider session sequence, which restarts with
    // each session, so the newest record is found by time instead.
    if (newest === undefined || activity.createdAt >= newest.createdAt) newest = activity;
  }
  const thread = newest
    ? Option.getOrNull(Option.map(decodeThreadTokenUsage(newest.payload), (p) => p.thread))
    : null;
  return { key, byTurnId, thread };
}

/**
 * The thread total to store with a turn's usage: that turn plus the latest
 * recorded usage of every other turn in `activities`. Summing every record,
 * rather than adding to the previous total, also counts turns recorded before
 * totals existed.
 */
export function sumThreadTokenUsage(input: {
  readonly activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "turnId" | "payload">>;
  readonly turnId: string;
  readonly usage: TurnTokenUsage;
  /** Every turn the thread has, including those without usage. */
  readonly turns: number;
}): ThreadTokenUsage {
  const byTurnId = new Map<string, TurnTokenUsage>();
  for (const activity of input.activities) {
    const usage = Option.getOrNull(decodeTurnTokenUsage(activity.payload));
    if (usage !== null && activity.turnId !== null) byTurnId.set(activity.turnId, usage);
  }
  byTurnId.set(input.turnId, input.usage);

  const total = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    countedTurns: byTurnId.size,
    turns: Math.max(input.turns, byTurnId.size),
    partialTurns: 0,
    subagentTurns: 0,
    subagentTokens: 0,
  };
  for (const usage of byTurnId.values()) {
    const counts = combinedTokenCounts(usage);
    total.inputTokens += counts.inputTokens;
    total.cachedInputTokens += counts.cachedInputTokens;
    total.cacheCreationTokens += counts.cacheCreationTokens;
    total.outputTokens += counts.outputTokens;
    total.reasoningTokens += counts.reasoningTokens;
    total.subagentTokens += subagentTokens(usage);
    if (usage.usageStatus !== "complete") total.partialTurns += 1;
    if (usage.hasSubagents && usage.subagents === undefined) total.subagentTurns += 1;
  }
  return total;
}

/** The main agent's usage plus any its subagents reported. */
function combinedTokenCounts(usage: TurnTokenUsage) {
  const subagents = usage.subagents;
  return {
    inputTokens: (usage.inputTokens ?? 0) + (subagents?.inputTokens ?? 0),
    cachedInputTokens: (usage.cachedInputTokens ?? 0) + (subagents?.cachedInputTokens ?? 0),
    cacheCreationTokens: (usage.cacheCreationTokens ?? 0) + (subagents?.cacheCreationTokens ?? 0),
    outputTokens: (usage.outputTokens ?? 0) + (subagents?.outputTokens ?? 0),
    reasoningTokens: (usage.reasoningTokens ?? 0) + (subagents?.reasoningTokens ?? 0),
  };
}

function subagentTokens(usage: TurnTokenUsage): number {
  return (usage.subagents?.inputTokens ?? 0) + (usage.subagents?.outputTokens ?? 0);
}

export interface TurnUsageView {
  /** The one figure shown beside the turn's timestamp or in the composer. */
  readonly headline: string;
  readonly rows: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly notes: ReadonlyArray<string>;
}

type TokenCounts = {
  readonly [
    K in
      | "inputTokens"
      | "cachedInputTokens"
      | "cacheCreationTokens"
      | "outputTokens"
      | "reasoningTokens"
  ]?: number | undefined;
};

function usageView(
  usage: TokenCounts,
  subagents: number,
  notes: ReadonlyArray<string>,
): TurnUsageView {
  // Input already includes cache reads and writes.
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cached = usage.cachedInputTokens ?? 0;
  const reasoning = usage.reasoningTokens ?? 0;
  const cacheWrites = usage.cacheCreationTokens ?? 0;

  const rows = [
    {
      label: "Input",
      value:
        input > 0 && cached > 0
          ? `${formatTokens(input)} (${formatPercent(cached / input, 0)} cached)`
          : formatTokens(input),
    },
    {
      label: "Output",
      value:
        reasoning > 0
          ? `${formatTokens(output)} (${formatTokens(reasoning)} reasoning)`
          : formatTokens(output),
    },
  ];
  if (cacheWrites > 0) rows.push({ label: "Cache writes", value: formatTokens(cacheWrites) });
  // Already within the rows above; this shows their share.
  if (subagents > 0) rows.push({ label: "Subagents", value: formatTokens(subagents) });

  return { headline: `${formatTokens(input + output)} tokens`, rows, notes };
}

export function turnUsageView(usage: TurnTokenUsage): TurnUsageView {
  const notes: string[] = [];
  if (usage.hasSubagents && usage.subagents === undefined) {
    notes.push("Subagent usage isn't included.");
  }
  if (usage.usageStatus === "partial") notes.push("The provider reported only some token counts.");
  return usageView(combinedTokenCounts(usage), subagentTokens(usage), notes);
}

export function threadUsageView(usage: ThreadTokenUsage): TurnUsageView {
  const notes: string[] = [];
  if (usage.countedTurns < usage.turns) {
    notes.push(`Includes ${usage.countedTurns} of ${usage.turns} turns.`);
  }
  if (usage.subagentTurns > 0) {
    notes.push(
      usage.subagentTokens
        ? "Some turns' subagent usage isn't included."
        : "Subagent usage isn't included.",
    );
  }
  if (usage.partialTurns > 0) notes.push("Some turns reported only some token counts.");
  return usageView(usage, usage.subagentTokens ?? 0, notes);
}
