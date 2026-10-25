import type { ModelUsage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ModelTokenUsage,
  ProviderRuntimeTurnStatus,
  SubagentTokenUsage,
  TurnTokenUsage,
} from "@t3tools/contracts";

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

export interface ClaudeModelUsageCounts {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  /** The same share split by model, with Claude's own cost, for pricing. */
  readonly byModel: ReadonlyArray<ModelTokenUsage>;
}

/**
 * The SDK keeps `modelUsage` as a running total for the whole query() session, including
 * subagents and compaction. A count that went down means the total restarted (a resume or
 * `/clear`), so the new total is this result's alone.
 */
export function claudeModelUsageDelta(
  previous: Readonly<Record<string, ModelUsage>> | undefined,
  current: Readonly<Record<string, ModelUsage>>,
): ClaudeModelUsageCounts {
  const restarted =
    previous !== undefined &&
    Object.entries(previous).some(([model, before]) => {
      const after = current[model];
      return (
        after === undefined ||
        after.inputTokens < before.inputTokens ||
        after.cacheReadInputTokens < before.cacheReadInputTokens ||
        after.cacheCreationInputTokens < before.cacheCreationInputTokens ||
        after.outputTokens < before.outputTokens ||
        after.costUSD < before.costUSD
      );
    });
  const baseline = restarted ? undefined : previous;
  const delta = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
  const byModel: ModelTokenUsage[] = [];
  for (const [model, after] of Object.entries(current)) {
    const before = baseline?.[model];
    const read = after.cacheReadInputTokens - (before?.cacheReadInputTokens ?? 0);
    const write = after.cacheCreationInputTokens - (before?.cacheCreationInputTokens ?? 0);
    const input = after.inputTokens - (before?.inputTokens ?? 0) + read + write;
    const output = after.outputTokens - (before?.outputTokens ?? 0);
    const costUsd = after.costUSD - (before?.costUSD ?? 0);
    delta.inputTokens += input;
    delta.cachedInputTokens += read;
    delta.cacheCreationTokens += write;
    delta.outputTokens += output;
    delta.reasoningTokens += Math.max(
      0,
      (after.thinkingTokens ?? 0) - (before?.thinkingTokens ?? 0),
    );
    if (input + output > 0) {
      byModel.push({
        model,
        inputTokens: input,
        cachedInputTokens: read,
        cacheCreationTokens: write,
        outputTokens: output,
        // Zero means Claude Code has no price for the model; rates may.
        ...(Number.isFinite(costUsd) && costUsd > 0 ? { reportedCostUsd: costUsd } : {}),
      });
    }
  }
  return { ...delta, byModel };
}

/**
 * What a turn's subagents used: the turn's share of `modelUsage` less the
 * main loop's own usage. Undefined when nothing is left over.
 */
function claudeSubagentTokenUsage(
  turn: ClaudeModelUsageCounts,
  main: Omit<ClaudeModelUsageCounts, "byModel">,
): SubagentTokenUsage | undefined {
  const inputTokens = Math.max(0, turn.inputTokens - main.inputTokens);
  const outputTokens = Math.max(0, turn.outputTokens - main.outputTokens);
  if (inputTokens + outputTokens === 0) return undefined;
  return {
    inputTokens,
    cachedInputTokens: Math.min(
      inputTokens,
      Math.max(0, turn.cachedInputTokens - main.cachedInputTokens),
    ),
    cacheCreationTokens: Math.min(
      inputTokens,
      Math.max(0, turn.cacheCreationTokens - main.cacheCreationTokens),
    ),
    outputTokens,
    reasoningTokens: Math.min(
      outputTokens,
      Math.max(0, turn.reasoningTokens - main.reasoningTokens),
    ),
  };
}

/**
 * `turnModelUsage` is the result's share of `modelUsage`
 * ({@link claudeModelUsageDelta}); with it, a turn that ran subagents reports
 * what they used, and every turn reports its tokens by model for pricing.
 */
const BILLED_USAGE_FIELDS = [
  "input_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "output_tokens",
] as const;

function addKnownCount(finalCount: unknown, earlierCounts: ReadonlyArray<unknown>): unknown {
  const known = finiteNonNegativeInteger(finalCount);
  if (known === undefined) return finalCount;
  return earlierCounts.reduce<number>(
    (sum, count) => sum + (finiteNonNegativeInteger(count) ?? 0),
    known,
  );
}

// Steering aborts the current segment; each SDK result reports only that segment's usage.
function withEarlierSegmentUsage(
  usage: Record<string, unknown>,
  earlierSegmentUsage: ReadonlyArray<unknown>,
): Record<string, unknown> {
  if (earlierSegmentUsage.length === 0) return usage;
  const segments = earlierSegmentUsage.map((segment) => (segment ?? {}) as Record<string, unknown>);
  const total = { ...usage };
  for (const field of BILLED_USAGE_FIELDS) {
    total[field] = addKnownCount(
      usage[field],
      segments.map((segment) => segment[field]),
    );
  }
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  if (outputDetails != null) {
    total.output_tokens_details = {
      ...outputDetails,
      thinking_tokens: addKnownCount(
        outputDetails.thinking_tokens,
        segments.map(
          (segment) =>
            (segment.output_tokens_details as Record<string, unknown> | undefined)?.thinking_tokens,
        ),
      ),
    };
  }
  return total;
}

export function normalizeClaudeTurnTokenUsage(
  result: { readonly subtype: SDKResultMessage["subtype"]; readonly usage?: unknown } | undefined,
  hasSubagents: boolean,
  terminalStatus: ProviderRuntimeTurnStatus,
  turnModelUsage?: ClaudeModelUsageCounts,
  earlierSegmentUsage: ReadonlyArray<unknown> = [],
): TurnTokenUsage {
  const finalUsage = result?.usage as Record<string, unknown> | undefined;
  const usage = finalUsage && withEarlierSegmentUsage(finalUsage, earlierSegmentUsage);
  if (!usage) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents,
    };
  }

  const uncachedInputTokens = finiteNonNegativeInteger(usage.input_tokens);
  const cachedInputTokens = finiteNonNegativeInteger(usage.cache_read_input_tokens);
  const cacheCreationTokens = finiteNonNegativeInteger(usage.cache_creation_input_tokens);
  const rawOutputTokens = finiteNonNegativeInteger(usage.output_tokens);
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  const thinkingTokens = finiteNonNegativeInteger(outputDetails?.thinking_tokens);
  const cachedInputContribution = usage.cache_read_input_tokens == null ? 0 : cachedInputTokens;
  const cacheCreationContribution =
    usage.cache_creation_input_tokens == null ? 0 : cacheCreationTokens;
  const inputTokens =
    uncachedInputTokens !== undefined &&
    cachedInputContribution !== undefined &&
    cacheCreationContribution !== undefined
      ? uncachedInputTokens + cachedInputContribution + cacheCreationContribution
      : undefined;
  const hasKnownUsage =
    uncachedInputTokens !== undefined ||
    cachedInputTokens !== undefined ||
    cacheCreationTokens !== undefined ||
    rawOutputTokens !== undefined;
  const hasPositiveUsage =
    (uncachedInputTokens ?? 0) +
      (cachedInputTokens ?? 0) +
      (cacheCreationTokens ?? 0) +
      (rawOutputTokens ?? 0) >
    0;

  if (!hasKnownUsage || (result?.subtype !== "success" && !hasPositiveUsage)) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents,
    };
  }

  // Only turns that ran subagents report the remainder, so compaction alone
  // never shows up as subagent usage.
  const subagents =
    hasSubagents &&
    turnModelUsage !== undefined &&
    inputTokens !== undefined &&
    rawOutputTokens !== undefined
      ? claudeSubagentTokenUsage(turnModelUsage, {
          inputTokens,
          cachedInputTokens: cachedInputTokens ?? 0,
          cacheCreationTokens: cacheCreationTokens ?? 0,
          outputTokens: rawOutputTokens,
          reasoningTokens: thinkingTokens ?? 0,
        })
      : undefined;
  const commonUsage = {
    usageScope: "main_agent",
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(thinkingTokens !== undefined && rawOutputTokens !== undefined
      ? { reasoningTokens: Math.min(rawOutputTokens, thinkingTokens) }
      : {}),
    hasSubagents,
    ...(subagents ? { subagents } : {}),
    ...(turnModelUsage && turnModelUsage.byModel.length > 0
      ? { byModel: turnModelUsage.byModel }
      : {}),
  } as const;
  if (
    terminalStatus === "completed" &&
    result?.subtype === "success" &&
    inputTokens !== undefined &&
    rawOutputTokens !== undefined
  ) {
    return {
      ...commonUsage,
      usageStatus: "complete",
      inputTokens,
      outputTokens: rawOutputTokens,
    };
  }
  return {
    ...commonUsage,
    usageStatus: "partial",
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(rawOutputTokens !== undefined ? { outputTokens: rawOutputTokens } : {}),
  };
}
