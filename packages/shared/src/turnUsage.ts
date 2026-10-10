/**
 * Reads `turn.usage` activities for the model and token count under each agent
 * turn and the thread total in the composer, and formats them identically on
 * web and mobile. The server uses {@link sumThreadTokenUsage} to write that
 * total.
 *
 * @module turnUsage
 */
import {
  ThreadTokenUsage,
  TURN_USAGE_ACTIVITY_KIND,
  TurnModel,
  TurnTokenUsage,
  type OrchestrationThreadActivity,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { formatPercent, formatTokens, formatUsd } from "./usageFormat.ts";

const decodeTurnTokenUsage = Schema.decodeUnknownOption(TurnTokenUsage);
const decodeTurnModel = Schema.decodeUnknownOption(TurnModel);
const decodeThreadTokenUsage = Schema.decodeUnknownOption(
  Schema.Struct({ thread: ThreadTokenUsage }),
);

/** One turn's usage record. Either part may be missing, but not both. */
export interface TurnRecord {
  readonly usage: TurnTokenUsage | null;
  readonly model: TurnModel | null;
}

export interface TurnUsageByTurn {
  /** Ids of the usage activities this was derived from. */
  readonly key: string;
  readonly byTurnId: ReadonlyMap<string, TurnRecord>;
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

  const byTurnId = new Map<string, TurnRecord>();
  let newest: OrchestrationThreadActivity | undefined;
  for (const activity of usageActivities) {
    const usage = Option.getOrNull(decodeTurnTokenUsage(activity.payload));
    const model = Option.getOrNull(decodeTurnModel(activity.payload));
    if ((usage !== null || model !== null) && activity.turnId !== null) {
      byTurnId.set(activity.turnId, { usage, model });
    }
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
  /** Null when the turn reported no usage. */
  readonly usage: TurnTokenUsage | null;
  /** Every turn the thread has, including those without usage. */
  readonly turns: number;
}): ThreadTokenUsage {
  const byTurnId = new Map<string, TurnTokenUsage>();
  for (const activity of input.activities) {
    const usage = Option.getOrNull(decodeTurnTokenUsage(activity.payload));
    if (usage !== null && activity.turnId !== null) byTurnId.set(activity.turnId, usage);
  }
  if (input.usage === null) byTurnId.delete(input.turnId);
  else byTurnId.set(input.turnId, input.usage);

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
    costUsd: 0,
    pricedTurns: 0,
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
    if (usage.costUsd !== undefined) {
      total.costUsd += usage.costUsd;
      total.pricedTurns += 1;
    }
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
  /** The token total shown beside the turn's timestamp or in the composer. */
  readonly headline: string;
  /** The estimated API cost, when known, for those who lead with cost. */
  readonly costUsd: number | null;
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

/** Cents, with sub-cent costs shown as such rather than as $0.00. */
function formatCost(usd: number): string {
  return usd > 0 && usd < 0.01 ? "<$0.01" : formatUsd(usd);
}

function usageView(
  usage: TokenCounts,
  subagents: number,
  costUsd: number | undefined,
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
  // What these tokens would cost at API rates; subscriptions bill separately.
  if (costUsd !== undefined) rows.push({ label: "Est. API cost", value: formatCost(costUsd) });

  return {
    headline: `${formatTokens(input + output)} tokens`,
    costUsd: costUsd ?? null,
    rows,
    notes,
  };
}

/** One character of a meter reading, on the wheel `position` from the right. */
export interface MeterWheel {
  readonly position: number;
  readonly char: string;
  /** The wheel's previous character, when the old reading reached it. */
  readonly before: string | undefined;
  /** Only a digit that changed rolls; everything else just shows. */
  readonly rolls: boolean;
}

/** Lines a new reading up against the previous one from the right, as wheels are. */
export function meterWheels(previous: string, text: string): ReadonlyArray<MeterWheel> {
  return [...text].map((char, index) => {
    const position = text.length - 1 - index;
    const before = previous[previous.length - 1 - position];
    return { position, char, before, rolls: before !== char && /\d/.test(char) };
  });
}

/** Which figure turn and thread usage lead with. */
export type TurnUsageFigure = "tokens" | "cost";

/** The figure a view leads with: its cost when chosen and known, else its tokens. */
export function usageFigureText(view: TurnUsageView, figure: TurnUsageFigure): string {
  return figure === "cost" && view.costUsd !== null ? formatCost(view.costUsd) : view.headline;
}

export function turnUsageView(usage: TurnTokenUsage): TurnUsageView {
  const notes: string[] = [];
  if (usage.hasSubagents && usage.subagents === undefined) {
    notes.push("Subagent usage isn't included.");
  }
  if (usage.usageStatus === "partial") notes.push("The provider reported only some token counts.");
  return usageView(combinedTokenCounts(usage), subagentTokens(usage), usage.costUsd, notes);
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
  const pricedTurns = usage.pricedTurns ?? 0;
  if (pricedTurns > 0 && pricedTurns < usage.countedTurns) {
    notes.push(`Cost covers ${pricedTurns} of ${usage.turns} turns.`);
  }
  return usageView(
    usage,
    usage.subagentTokens ?? 0,
    pricedTurns > 0 ? usage.costUsd : undefined,
    notes,
  );
}

/** What shows under a turn: the model it ran on and its usage figure. */
export interface TurnSummaryView {
  readonly model: string | null;
  readonly usage: TurnUsageView | null;
  /** The record it was built from, so unchanged turns keep their view. */
  readonly record: TurnRecord;
}

export const EMPTY_TURN_SUMMARIES: ReadonlyMap<string, TurnSummaryView> = new Map();

/**
 * Builds each turn's summary. Turns whose record and model label are unchanged
 * keep their `previous` view, and an unchanged map keeps its identity, so a
 * provider refresh does not re-render the timeline.
 */
export function turnSummaryViews(
  byTurnId: ReadonlyMap<string, TurnRecord>,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "models">>,
  previous: ReadonlyMap<string, TurnSummaryView> = EMPTY_TURN_SUMMARIES,
): ReadonlyMap<string, TurnSummaryView> {
  const views = new Map<string, TurnSummaryView>();
  let changed = byTurnId.size !== previous.size;
  for (const [turnId, record] of byTurnId) {
    const model = record.model ? turnModelLabel(record.model, providers) : null;
    const prior = previous.get(turnId);
    if (prior?.record === record && prior.model === model) {
      views.set(turnId, prior);
      continue;
    }
    changed = true;
    views.set(turnId, {
      model,
      usage: record.usage ? turnUsageView(record.usage) : null,
      record,
    });
  }
  return changed ? views : previous;
}

/**
 * Names a turn's model and effort as the composer does, e.g.
 * "GPT-6.1 Sol (Medium)". Models no longer listed keep the provider's ids.
 */
export function turnModelLabel(
  turnModel: TurnModel,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "models">>,
): string {
  const provider = providers.find((candidate) => candidate.instanceId === turnModel.instanceId);
  const model = (provider ? [provider] : providers)
    .flatMap((candidate) => candidate.models)
    .find(
      (candidate) =>
        candidate.slug === turnModel.model || candidate.aliases?.includes(turnModel.model),
    );
  const name = model?.name ?? turnModel.model;
  if (turnModel.effort === undefined) return name;
  // Effort is an option id. Reasoning is a model's first select option, and
  // its ids don't overlap the others' (context window, service tier, agent).
  const effort =
    (model?.capabilities?.optionDescriptors ?? [])
      .flatMap((descriptor) => (descriptor.type === "select" ? descriptor.options : []))
      .find((option) => option.id === turnModel.effort)?.label ?? turnModel.effort;
  return `${name} (${effort})`;
}
