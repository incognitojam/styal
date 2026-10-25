import type { ModelTokenUsage, SubagentTokenUsage, TurnTokenUsage } from "@t3tools/contracts";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

export type CodexCumulativeTokenUsage = {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens?: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
};

interface CodexTurnTokenUsageAccumulator {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number | undefined;
  outputTokens: number;
  reasoningTokens: number;
  observed: boolean;
  hasSubagents: boolean;
  /** Growth of subagent threads while this turn was live. */
  subagents: CodexCumulativeTokenUsage | undefined;
  /** The same growth by subagent model, keyed "" when Codex has not named it. */
  readonly subagentsByModel: Map<string, CodexCumulativeTokenUsage>;
}

export interface CodexTurnTokenUsageState {
  baseline: CodexCumulativeTokenUsage | undefined;
  activeTurnId: string | undefined;
  readonly byTurnId: Map<string, CodexTurnTokenUsageAccumulator>;
}

function codexTokenUsageBreakdown(
  usage: EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification__TokenUsageBreakdown,
): CodexCumulativeTokenUsage {
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    ...(usage.cacheWriteInputTokens !== undefined
      ? { cacheCreationTokens: usage.cacheWriteInputTokens }
      : {}),
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningOutputTokens,
  };
}

export function makeCodexTurnTokenUsageState(): CodexTurnTokenUsageState {
  return {
    baseline: undefined,
    activeTurnId: undefined,
    byTurnId: new Map(),
  };
}

export function getCodexTurnAccumulator(
  state: CodexTurnTokenUsageState,
  turnId: string,
): CodexTurnTokenUsageAccumulator {
  const existing = state.byTurnId.get(turnId);
  if (existing) return existing;
  const created: CodexTurnTokenUsageAccumulator = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    observed: false,
    hasSubagents: false,
    subagents: undefined,
    subagentsByModel: new Map(),
  };
  state.byTurnId.set(turnId, created);
  return created;
}

/** total is thread-wide; last covers the newest model response. */
function codexTurnTokenUsageDelta(
  previous: CodexCumulativeTokenUsage | undefined,
  current: CodexCumulativeTokenUsage,
  last: CodexCumulativeTokenUsage,
): CodexCumulativeTokenUsage {
  if (
    previous === undefined ||
    current.inputTokens < previous.inputTokens ||
    current.cachedInputTokens < previous.cachedInputTokens ||
    current.outputTokens < previous.outputTokens ||
    current.reasoningTokens < previous.reasoningTokens
  ) {
    return last;
  }
  return {
    inputTokens: current.inputTokens - previous.inputTokens,
    cachedInputTokens: current.cachedInputTokens - previous.cachedInputTokens,
    ...(current.cacheCreationTokens !== undefined &&
    previous.cacheCreationTokens !== undefined &&
    current.cacheCreationTokens >= previous.cacheCreationTokens
      ? { cacheCreationTokens: current.cacheCreationTokens - previous.cacheCreationTokens }
      : {}),
    outputTokens: current.outputTokens - previous.outputTokens,
    reasoningTokens: current.reasoningTokens - previous.reasoningTokens,
  };
}

/** Adds one notification's usage to the live turn, and returns what it added. */
export function accumulateCodexTurnTokenUsage(
  state: CodexTurnTokenUsageState,
  turnId: string,
  usage: EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification["tokenUsage"],
): CodexCumulativeTokenUsage | undefined {
  const current = codexTokenUsageBreakdown(usage.total);
  if (state.activeTurnId !== turnId) {
    // Every thread-wide total updates the baseline; late finished-turn updates do not count toward the live turn.
    state.baseline = current;
    return undefined;
  }

  const accumulator = getCodexTurnAccumulator(state, turnId);
  const delta = codexTurnTokenUsageDelta(
    state.baseline,
    current,
    codexTokenUsageBreakdown(usage.last),
  );
  state.baseline = current;

  if (
    delta.inputTokens > 0 ||
    delta.cachedInputTokens > 0 ||
    delta.outputTokens > 0 ||
    delta.reasoningTokens > 0
  ) {
    accumulator.observed = true;
  }
  accumulator.inputTokens += delta.inputTokens;
  accumulator.cachedInputTokens += delta.cachedInputTokens;
  accumulator.outputTokens += delta.outputTokens;
  accumulator.reasoningTokens += delta.reasoningTokens;
  if (delta.cacheCreationTokens === undefined) {
    accumulator.cacheCreationTokens = undefined;
  } else if (accumulator.cacheCreationTokens !== undefined) {
    accumulator.cacheCreationTokens += delta.cacheCreationTokens;
  }
  return delta;
}

/**
 * Adds a subagent thread's usage to the turn that spawned it, while that turn
 * is live. Usage from a subagent that outlives the turn stays on its own
 * thread only.
 */
export function addCodexSubagentTokenUsage(
  state: CodexTurnTokenUsageState,
  turnId: string,
  delta: CodexCumulativeTokenUsage,
  model: string | undefined,
): void {
  if (state.activeTurnId !== turnId) return;
  const accumulator = getCodexTurnAccumulator(state, turnId);
  const add = (previous: CodexCumulativeTokenUsage | undefined) => ({
    inputTokens: (previous?.inputTokens ?? 0) + delta.inputTokens,
    cachedInputTokens: (previous?.cachedInputTokens ?? 0) + delta.cachedInputTokens,
    cacheCreationTokens: (previous?.cacheCreationTokens ?? 0) + (delta.cacheCreationTokens ?? 0),
    outputTokens: (previous?.outputTokens ?? 0) + delta.outputTokens,
    reasoningTokens: (previous?.reasoningTokens ?? 0) + delta.reasoningTokens,
  });
  accumulator.subagents = add(accumulator.subagents);
  const key = model?.trim() ?? "";
  accumulator.subagentsByModel.set(key, add(accumulator.subagentsByModel.get(key)));
}

function codexSubagentTokenUsage(
  usage: CodexCumulativeTokenUsage | undefined,
): SubagentTokenUsage | undefined {
  if (!usage || usage.inputTokens + usage.outputTokens === 0) return undefined;
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: Math.min(usage.inputTokens, usage.cachedInputTokens),
    ...(usage.cacheCreationTokens
      ? { cacheCreationTokens: Math.min(usage.inputTokens, usage.cacheCreationTokens) }
      : {}),
    outputTokens: usage.outputTokens,
    reasoningTokens: Math.min(usage.outputTokens, usage.reasoningTokens),
  };
}

/**
 * Splits a turn's tokens by model for pricing when its subagents named their
 * own. Without that, every token is priced at the turn's model.
 */
function codexTokensByModel(
  usage: CodexTurnTokenUsageAccumulator,
): ReadonlyArray<ModelTokenUsage> | undefined {
  const named = [...usage.subagentsByModel].filter(([model]) => model.length > 0);
  if (named.length === 0) return undefined;
  const tokens = (counts: CodexCumulativeTokenUsage) => ({
    inputTokens: counts.inputTokens,
    cachedInputTokens: Math.min(counts.inputTokens, counts.cachedInputTokens),
    cacheCreationTokens: Math.min(counts.inputTokens, counts.cacheCreationTokens ?? 0),
    outputTokens: counts.outputTokens,
  });
  const unnamed = usage.subagentsByModel.get("");
  return [
    // The main agent and any subagent on the turn's own model.
    tokens({
      inputTokens: usage.inputTokens + (unnamed?.inputTokens ?? 0),
      cachedInputTokens: usage.cachedInputTokens + (unnamed?.cachedInputTokens ?? 0),
      cacheCreationTokens: (usage.cacheCreationTokens ?? 0) + (unnamed?.cacheCreationTokens ?? 0),
      outputTokens: usage.outputTokens + (unnamed?.outputTokens ?? 0),
      reasoningTokens: 0,
    }),
    ...named.map(([model, counts]) => ({ model, ...tokens(counts) })),
  ];
}

export function currentCodexTurnTokenUsage(
  state: CodexTurnTokenUsageState,
  turnId: string,
  completed = false,
): TurnTokenUsage {
  const usage = state.byTurnId.get(turnId);
  if (!usage) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents: false,
    };
  }

  if (!usage.observed) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents: usage.hasSubagents,
    };
  }

  const subagents = codexSubagentTokenUsage(usage.subagents);
  const byModel = codexTokensByModel(usage);
  // Codex counts cache reads and writes inside inputTokens. Clamp the
  // subsets so the record keeps the documented relationships even if a
  // counter drifts.
  return {
    usageStatus: completed ? "complete" : "partial",
    usageScope: "main_agent",
    inputTokens: usage.inputTokens,
    cachedInputTokens: Math.min(usage.inputTokens, usage.cachedInputTokens),
    ...(usage.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: Math.min(usage.inputTokens, usage.cacheCreationTokens) }
      : {}),
    outputTokens: usage.outputTokens,
    reasoningTokens: Math.min(usage.outputTokens, usage.reasoningTokens),
    hasSubagents: usage.hasSubagents,
    ...(subagents ? { subagents } : {}),
    ...(byModel ? { byModel } : {}),
  };
}

export function completeCodexTurnTokenUsage(
  state: CodexTurnTokenUsageState,
  turnId: string,
  completed: boolean,
): TurnTokenUsage {
  const usage = currentCodexTurnTokenUsage(state, turnId, completed);
  state.byTurnId.delete(turnId);
  if (state.activeTurnId === turnId) state.activeTurnId = undefined;
  return usage;
}
