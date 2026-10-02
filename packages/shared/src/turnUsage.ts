/**
 * Reads `turn.usage` activities for the token count under each agent turn,
 * and formats them identically on web and mobile.
 *
 * @module turnUsage
 */
import {
  TURN_USAGE_ACTIVITY_KIND,
  TurnTokenUsage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { formatPercent, formatTokens } from "./usageFormat.ts";

const decodeTurnTokenUsage = Schema.decodeUnknownOption(TurnTokenUsage);

export interface TurnUsageByTurn {
  /** Ids of the usage activities this was derived from. */
  readonly key: string;
  readonly byTurnId: ReadonlyMap<string, TurnTokenUsage>;
}

export const EMPTY_TURN_USAGE: TurnUsageByTurn = { key: "", byTurnId: new Map() };

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
  for (const activity of usageActivities) {
    const usage = Option.getOrNull(decodeTurnTokenUsage(activity.payload));
    if (usage !== null && activity.turnId !== null) byTurnId.set(activity.turnId, usage);
  }
  return { key, byTurnId };
}

export interface TurnUsageView {
  /** The one figure shown beside the turn's timestamp. */
  readonly headline: string;
  readonly rows: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly notes: ReadonlyArray<string>;
}

export function turnUsageView(usage: TurnTokenUsage): TurnUsageView {
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

  const notes: string[] = [];
  if (usage.hasSubagents) notes.push("Subagent usage isn't included.");
  if (usage.usageStatus === "partial") notes.push("The provider reported only some token counts.");

  return { headline: `${formatTokens(input + output)} tokens`, rows, notes };
}
