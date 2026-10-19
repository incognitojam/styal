import { describe, expect, it } from "vite-plus/test";
import type { ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import { claudeModelUsageDelta, normalizeClaudeTurnTokenUsage } from "./ClaudeTurnTokenUsage.ts";
import {
  accumulateCodexTurnTokenUsage,
  addCodexSubagentTokenUsage,
  completeCodexTurnTokenUsage,
  getCodexTurnAccumulator,
  makeCodexTurnTokenUsageState,
} from "./CodexTurnTokenUsage.ts";

const breakdown = (input: number, cached: number, output: number) => ({
  totalTokens: input + output,
  inputTokens: input,
  cachedInputTokens: cached,
  outputTokens: output,
  reasoningOutputTokens: 0,
});
const update = (total: ReturnType<typeof breakdown>, last = total) => ({
  total,
  last,
  modelContextWindow: 200_000,
});

describe("billable native turn usage", () => {
  it("adds each Codex response once and excludes the prior resumed history", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "turn";
    const first = update(breakdown(1010, 505, 102), breakdown(10, 5, 2));
    accumulateCodexTurnTokenUsage(state, "turn", first);
    accumulateCodexTurnTokenUsage(state, "turn", first);
    accumulateCodexTurnTokenUsage(
      state,
      "turn",
      update(breakdown(1030, 515, 108), breakdown(20, 10, 6)),
    );
    expect(completeCodexTurnTokenUsage(state, "turn", true)).toEqual({
      usageStatus: "complete",
      usageScope: "main_agent",
      hasSubagents: false,
      inputTokens: 30,
      cachedInputTokens: 15,
      outputTokens: 8,
      reasoningTokens: 0,
    });
  });

  it("keeps previous responses when compaction resets Codex cumulative counters", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "turn";
    accumulateCodexTurnTokenUsage(state, "turn", update(breakdown(100, 40, 20)));
    accumulateCodexTurnTokenUsage(state, "turn", update(breakdown(20, 5, 3)));
    getCodexTurnAccumulator(state, "turn").hasSubagents = true;
    expect(completeCodexTurnTokenUsage(state, "turn", false)).toMatchObject({
      usageStatus: "partial",
      hasSubagents: true,
      inputTokens: 120,
      cachedInputTokens: 45,
      outputTokens: 23,
    });
  });

  it("does not bill late Codex updates against the next active turn", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "next";
    accumulateCodexTurnTokenUsage(state, "previous", update(breakdown(100, 10, 20)));
    accumulateCodexTurnTokenUsage(
      state,
      "next",
      update(breakdown(104, 12, 21), breakdown(4, 2, 1)),
    );
    expect(completeCodexTurnTokenUsage(state, "next", true)).toMatchObject({
      inputTokens: 4,
      outputTokens: 1,
    });
    expect(completeCodexTurnTokenUsage(state, "missing", false).usageStatus).toBe("unavailable");
  });

  it("counts Claude cached input inside total input and bounds thinking output", () => {
    expect(
      normalizeClaudeTurnTokenUsage(
        {
          subtype: "success",
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 10,
            output_tokens: 20,
            output_tokens_details: { thinking_tokens: 25 },
          },
        },
        true,
        "completed",
      ),
    ).toEqual({
      usageStatus: "complete",
      usageScope: "main_agent",
      hasSubagents: true,
      inputTokens: 150,
      cachedInputTokens: 40,
      cacheCreationTokens: 10,
      outputTokens: 20,
      reasoningTokens: 20,
    });
  });

  it("does not turn a zeroed Claude crash result into a measured zero-cost turn", () => {
    expect(
      normalizeClaudeTurnTokenUsage(
        {
          subtype: "error_during_execution",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
        false,
        "failed",
      ).usageStatus,
    ).toBe("unavailable");
    expect(
      normalizeClaudeTurnTokenUsage(
        {
          subtype: "success",
          usage: {
            input_tokens: 4,
            output_tokens: 2,
          },
        },
        false,
        "interrupted",
      ),
    ).toMatchObject({ usageStatus: "partial", inputTokens: 4, outputTokens: 2 });
  });

  it("reports what Claude subagents used beyond the main loop, by model", () => {
    const modelUsage = (
      input: number,
      read: number,
      write: number,
      output: number,
      costUSD: number,
    ): ModelUsage => ({
      inputTokens: input,
      outputTokens: output,
      cacheReadInputTokens: read,
      cacheCreationInputTokens: write,
      webSearchRequests: 0,
      costUSD,
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
    });
    const earlier = { opus: modelUsage(10, 100, 20, 30, 1) };
    // The main loop ran on opus; a subagent ran on haiku and some more opus.
    const share = claudeModelUsageDelta(earlier, {
      opus: modelUsage(15, 300, 30, 50, 1.5),
      haiku: modelUsage(4, 40, 6, 8, 0.02),
    });
    expect(share.byModel).toEqual([
      {
        model: "opus",
        inputTokens: 215,
        cachedInputTokens: 200,
        cacheCreationTokens: 10,
        outputTokens: 20,
        reportedCostUsd: 0.5,
      },
      {
        model: "haiku",
        inputTokens: 50,
        cachedInputTokens: 40,
        cacheCreationTokens: 6,
        outputTokens: 8,
        reportedCostUsd: 0.02,
      },
    ]);
    const result = {
      subtype: "success" as const,
      usage: {
        input_tokens: 3,
        cache_read_input_tokens: 150,
        cache_creation_input_tokens: 7,
        output_tokens: 12,
      },
    };
    expect(normalizeClaudeTurnTokenUsage(result, true, "completed", share)).toMatchObject({
      inputTokens: 160,
      outputTokens: 12,
      subagents: {
        inputTokens: 105,
        cachedInputTokens: 90,
        cacheCreationTokens: 9,
        outputTokens: 16,
      },
    });
    // Without a subagent, the leftover is compaction and other internal calls.
    expect(
      normalizeClaudeTurnTokenUsage(result, false, "completed", share).subagents,
    ).toBeUndefined();
  });

  it("treats a Claude modelUsage total that went down as a restarted session", () => {
    const usage = (input: number): ModelUsage => ({
      inputTokens: input,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
    });
    expect(claudeModelUsageDelta({ opus: usage(500) }, { opus: usage(40) })).toMatchObject({
      inputTokens: 40,
      outputTokens: 1,
    });
  });

  it("adds Codex subagent usage only to the live turn, split by subagent model", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "turn";
    accumulateCodexTurnTokenUsage(state, "turn", update(breakdown(100, 40, 10)));
    const child = { inputTokens: 30, cachedInputTokens: 10, outputTokens: 5, reasoningTokens: 2 };
    addCodexSubagentTokenUsage(state, "turn", child, "gpt-5-mini");
    addCodexSubagentTokenUsage(state, "turn", child, undefined);
    addCodexSubagentTokenUsage(state, "earlier", child, "gpt-5-mini");
    expect(completeCodexTurnTokenUsage(state, "turn", true)).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
      subagents: { inputTokens: 60, cachedInputTokens: 20, outputTokens: 10, reasoningTokens: 4 },
      byModel: [
        { inputTokens: 130, cachedInputTokens: 50, cacheCreationTokens: 0, outputTokens: 15 },
        {
          model: "gpt-5-mini",
          inputTokens: 30,
          cachedInputTokens: 10,
          cacheCreationTokens: 0,
          outputTokens: 5,
        },
      ],
    });
  });
});
