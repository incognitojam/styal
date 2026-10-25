/**
 * Shared so web and mobile format usage identically; the server writes the thread total with
 * {@link sumThreadTokenUsage}.
 *
 * @module turnUsage
 */
import {
  ThreadTokenUsage,
  TURN_USAGE_ACTIVITY_KIND,
  TurnModel,
  TurnTokenUsage,
  type ServerProvider,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { formatPercent, formatTokens, formatUsd } from "./usageFormat.ts";
import { getModelSelectionStringOptionValue } from "./model.ts";

const decodeTurnTokenUsage = Schema.decodeUnknownOption(TurnTokenUsage);
const decodeTurnTokenUsageSync = Schema.decodeUnknownSync(TurnTokenUsage);
const decodeTurnModel = Schema.decodeUnknownOption(TurnModel);
const decodeThreadTokenUsage = Schema.decodeUnknownOption(
  Schema.Struct({ thread: ThreadTokenUsage }),
);

/** V1 records are read only during import; callers need no retired runtime types. */
export interface UsageActivity {
  readonly id: string;
  readonly kind: string;
  readonly turnId: string | null;
  readonly payload: unknown;
  readonly createdAt: string;
}

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

/** Several native turns can complete one app run after compaction or a handoff. */
export function addTurnTokenUsage(a: TurnTokenUsage, b: TurnTokenUsage): TurnTokenUsage {
  const fields = [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "cacheCreationTokens",
    "reasoningTokens",
  ] as const;
  const counts = Object.fromEntries(
    fields.flatMap((field) =>
      a[field] === undefined && b[field] === undefined
        ? []
        : [[field, (a[field] ?? 0) + (b[field] ?? 0)]],
    ),
  );
  const subagents =
    a.subagents === undefined && b.subagents === undefined
      ? undefined
      : Object.fromEntries(
          fields.flatMap((field) =>
            a.subagents?.[field] === undefined && b.subagents?.[field] === undefined
              ? []
              : [[field, (a.subagents?.[field] ?? 0) + (b.subagents?.[field] ?? 0)]],
          ),
        );
  return decodeTurnTokenUsageSync({
    ...counts,
    usageScope: "main_agent",
    usageStatus:
      a.usageStatus === "complete" && b.usageStatus === "complete" ? "complete" : "partial",
    hasSubagents: a.hasSubagents || b.hasSubagents,
    ...(subagents === undefined ? {} : { subagents }),
    ...(a.costUsd === undefined || b.costUsd === undefined
      ? {}
      : { costUsd: a.costUsd + b.costUsd }),
  });
}

/** Reads frozen V1 records and retained root V2 provider turns through the same view. */
export function deriveProjectionTurnUsage(
  projection: {
    readonly legacyTurnUsage?: OrchestrationV2ThreadProjection["legacyTurnUsage"];
    readonly nodes: ReadonlyArray<Pick<OrchestrationV2ExecutionNode, "id" | "runId" | "kind">>;
    readonly runs: ReadonlyArray<
      Pick<OrchestrationV2Run, "id" | "ordinal" | "status" | "modelSelection">
    >;
    readonly providerTurns: ReadonlyArray<
      Pick<
        OrchestrationV2ProviderTurn,
        "nodeId" | "ordinal" | "turnTokenUsage" | "turnModel" | "threadTokenUsage"
      >
    >;
  },
  previous: TurnUsageByTurn = EMPTY_TURN_USAGE,
): TurnUsageByTurn {
  const records = new Map<string, TurnRecord>(
    projection.legacyTurnUsage?.records.map((record) => [record.turnId, record]) ?? [],
  );
  const nodes = new Map(projection.nodes.map((node) => [node.id, node]));
  const runs = new Map(projection.runs.map((run) => [run.id, run]));
  const retainedRootTurns = projection.providerTurns.filter((turn) => {
    const node = nodes.get(turn.nodeId);
    const run =
      node?.runId === null || node?.runId === undefined ? undefined : runs.get(node.runId);
    return node?.kind === "root_turn" && run !== undefined && run.status !== "rolled_back";
  });
  for (const turn of retainedRootTurns) {
    const node = nodes.get(turn.nodeId)!;
    const runId = node.runId!;
    const selection = runs.get(runId)?.modelSelection;
    const effort =
      selection === undefined
        ? undefined
        : (getModelSelectionStringOptionValue(selection, "reasoningEffort") ??
          getModelSelectionStringOptionValue(selection, "effort"));
    const previousUsage = records.get(runId)?.usage;
    records.set(runId, {
      usage:
        turn.turnTokenUsage === undefined
          ? (previousUsage ?? null)
          : previousUsage
            ? addTurnTokenUsage(previousUsage, turn.turnTokenUsage)
            : turn.turnTokenUsage,
      model:
        turn.turnModel ??
        (selection === undefined || selection === null
          ? null
          : {
              instanceId: selection.instanceId,
              model: selection.model,
              ...(effort === undefined ? {} : { effort }),
            }),
    });
  }
  const latestTotal = retainedRootTurns
    .filter((turn) => turn.threadTokenUsage !== undefined)
    .sort((a, b) => {
      const runOrdinal = (turn: typeof a) => runs.get(nodes.get(turn.nodeId)!.runId!)!.ordinal;
      return runOrdinal(b) - runOrdinal(a) || b.ordinal - a.ordinal;
    })[0]?.threadTokenUsage;
  const thread = latestTotal ?? projection.legacyTurnUsage?.thread ?? null;
  const key = JSON.stringify([Array.from(records), thread]);
  return key === previous.key ? previous : { key, byTurnId: records, thread };
}

/**
 * Collects usage by turn. Returns `previous` unchanged while the thread gains
 * no usage activities, so views keyed on its identity skip streamed updates.
 */
export function deriveTurnUsage(
  activities: ReadonlyArray<UsageActivity>,
  previous: TurnUsageByTurn = EMPTY_TURN_USAGE,
): TurnUsageByTurn {
  const usageActivities = activities.filter(
    (activity) => activity.kind === TURN_USAGE_ACTIVITY_KIND && activity.turnId !== null,
  );
  const key = usageActivities.map((activity) => activity.id).join(",");
  if (key === previous.key) return previous;

  const byTurnId = new Map<string, TurnRecord>();
  let newest: UsageActivity | undefined;
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
  readonly activities: ReadonlyArray<Pick<UsageActivity, "turnId" | "payload">>;
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
  return [...byTurnId.values()].reduce(addTurnUsage, total);
}

/** A thread total with a running turn's usage so far added in. */
export function withLiveTurnUsage(
  thread: ThreadTokenUsage | null,
  live: TurnTokenUsage,
): ThreadTokenUsage {
  const base = thread ?? {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    countedTurns: 0,
    turns: 0,
    partialTurns: 0,
    subagentTurns: 0,
  };
  const total = addTurnUsage(
    {
      ...base,
      countedTurns: base.countedTurns + 1,
      turns: base.turns + 1,
      subagentTokens: base.subagentTokens ?? 0,
      costUsd: base.costUsd ?? 0,
      pricedTurns: base.pricedTurns ?? 0,
    },
    live,
  );
  // A running turn has only some of its usage by nature.
  return { ...total, partialTurns: base.partialTurns };
}

type ThreadTokenTotal = ThreadTokenUsage & {
  subagentTokens: number;
  costUsd: number;
  pricedTurns: number;
};

/** Adds one turn's usage into a total whose turn counts already include it. */
function addTurnUsage(total: ThreadTokenTotal, usage: TurnTokenUsage): ThreadTokenTotal {
  const counts = combinedTokenCounts(usage);
  const priced = usage.costUsd !== undefined;
  return {
    ...total,
    inputTokens: total.inputTokens + counts.inputTokens,
    cachedInputTokens: total.cachedInputTokens + counts.cachedInputTokens,
    cacheCreationTokens: total.cacheCreationTokens + counts.cacheCreationTokens,
    outputTokens: total.outputTokens + counts.outputTokens,
    reasoningTokens: total.reasoningTokens + counts.reasoningTokens,
    subagentTokens: total.subagentTokens + subagentTokens(usage),
    partialTurns: total.partialTurns + (usage.usageStatus !== "complete" ? 1 : 0),
    subagentTurns:
      total.subagentTurns + (usage.hasSubagents && usage.subagents === undefined ? 1 : 0),
    costUsd: total.costUsd + (usage.costUsd ?? 0),
    pricedTurns: total.pricedTurns + (priced ? 1 : 0),
  };
}

/** Adds frozen imported totals to the usage recorded by the V2 runtime. */
export function addThreadTokenUsage(a: ThreadTokenUsage, b: ThreadTokenUsage): ThreadTokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    countedTurns: a.countedTurns + b.countedTurns,
    turns: a.turns + b.turns,
    partialTurns: a.partialTurns + b.partialTurns,
    subagentTurns: a.subagentTurns + b.subagentTurns,
    subagentTokens: (a.subagentTokens ?? 0) + (b.subagentTokens ?? 0),
    costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0),
    pricedTurns: (a.pricedTurns ?? 0) + (b.pricedTurns ?? 0),
  };
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
  /** The same total without its unit, for where the label is short of room. */
  readonly tokens: string;
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

  const tokens = formatTokens(input + output);
  return {
    headline: `${tokens} tokens`,
    tokens,
    costUsd: costUsd ?? null,
    rows,
    notes,
  };
}

/** A run of a meter reading that shows or rolls as one wheel. */
export interface MeterWheel {
  /** Where the wheel ends, counted from the reading's right; keys it. */
  readonly position: number;
  readonly text: string;
  /** What the wheel showed before, when it rolls. */
  readonly before: string | undefined;
  readonly rolls: boolean;
  /** Rolling wheels turn in this order, rightmost first. */
  readonly order: number;
}

const METER_READING = /^(\D*)(\d(?:.*\d)?)(\D*)$/;

function commonTail(a: string, b: string): string {
  let length = 0;
  while (length < a.length && length < b.length && a.at(-1 - length) === b.at(-1 - length)) {
    length += 1;
  }
  return length === 0 ? "" : a.slice(-length);
}

/** Whether two numbers line up from the right with their separators in place. */
function sameShape(previous: string, next: string): boolean {
  const [shorter, longer] = previous.length <= next.length ? [previous, next] : [next, previous];
  const extra = longer.length - shorter.length;
  if (!/^\d*$/.test(longer.slice(0, extra))) return false;
  return [...shorter].every((char, index) => /\d/.test(char) === /\d/.test(longer[extra + index]!));
}

/**
 * Digits line up from the right and each changed one rolls alone while the number keeps its
 * shape; when the shape or unit changes ("998K" to "1.00M") the number and unit roll together.
 */
export function meterWheels(previous: string, text: string): ReadonlyArray<MeterWheel> {
  const was = METER_READING.exec(previous);
  const now = METER_READING.exec(text);
  if (!was || !now) {
    const rolls = previous !== text;
    return [{ position: 0, text, before: rolls ? previous : undefined, rolls, order: 0 }];
  }
  const [, prefix = "", number = "", suffix = ""] = now;
  const [, , wasNumber = "", wasSuffix = ""] = was;
  const wheels: Array<Omit<MeterWheel, "order">> = [];
  const still = (chars: string, end: number) =>
    [...chars].forEach((char, index) =>
      wheels.push({
        position: end + chars.length - 1 - index,
        text: char,
        before: undefined,
        rolls: false,
      }),
    );
  if (suffix === wasSuffix && sameShape(wasNumber, number)) {
    still(prefix, suffix.length + number.length);
    [...number].forEach((char, index) => {
      const fromRight = number.length - 1 - index;
      const before = wasNumber[wasNumber.length - 1 - fromRight];
      const rolls = before !== char;
      wheels.push({ position: suffix.length + fromRight, text: char, before, rolls });
    });
    still(suffix, 0);
  } else {
    const tail = commonTail(suffix, wasSuffix);
    const head = number + suffix.slice(0, suffix.length - tail.length);
    const wasHead = wasNumber + wasSuffix.slice(0, wasSuffix.length - tail.length);
    still(prefix, tail.length + head.length);
    wheels.push({ position: tail.length, text: head, before: wasHead, rolls: true });
    still(tail, 0);
  }
  let order = wheels.filter((wheel) => wheel.rolls).length;
  return wheels.map((wheel) => ({ ...wheel, order: wheel.rolls ? --order : 0 }));
}

/** Which figure turn and thread usage lead with. */
export type TurnUsageFigure = "tokens" | "cost";

/** The figure a view leads with: its cost when chosen and known, else its tokens. */
export function usageFigureShown(view: TurnUsageView, figure: TurnUsageFigure): TurnUsageFigure {
  return figure === "cost" && view.costUsd !== null ? "cost" : "tokens";
}

/** The figure as text; `short` drops the token unit where room is tight. */
export function usageFigureText(
  view: TurnUsageView,
  figure: TurnUsageFigure,
  short = false,
): string {
  if (view.costUsd !== null && usageFigureShown(view, figure) === "cost") {
    return formatCost(view.costUsd);
  }
  return short ? view.tokens : view.headline;
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

/** A thread's total on one line, where nothing nearby says what a bare cost is. */
export function threadUsageSummary(usage: ThreadTokenUsage, figure: TurnUsageFigure): string {
  const view = threadUsageView(usage);
  const text = usageFigureText(view, figure);
  return usageFigureShown(view, figure) === "cost" ? `${text} est. API cost` : text;
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
