import {
  EventId,
  ProviderInstanceId,
  TurnId,
  type OrchestrationThreadActivity,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveTurnUsage,
  sumThreadTokenUsage,
  threadUsageView,
  turnModelLabel,
  turnUsageView,
} from "./turnUsage.ts";

const usage = {
  usageScope: "main_agent",
  usageStatus: "complete",
  inputTokens: 1_000_000,
  cachedInputTokens: 600_000,
  outputTokens: 50_000,
  reasoningTokens: 20_000,
  hasSubagents: false,
} as const;

function activity(
  id: string,
  turnId: string,
  kind: string,
  payload: unknown = usage,
  createdAt = "2026-01-01T00:00:00.000Z",
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: "Turn usage",
    turnId: TurnId.make(turnId),
    createdAt,
    payload,
  };
}

const threadTotal = {
  inputTokens: 3_000_000,
  cachedInputTokens: 2_000_000,
  cacheCreationTokens: 0,
  outputTokens: 120_000,
  reasoningTokens: 40_000,
  countedTurns: 3,
  turns: 3,
  partialTurns: 0,
  subagentTurns: 0,
} as const;

describe("deriveTurnUsage", () => {
  it("indexes usage by turn and skips records it cannot read", () => {
    const derived = deriveTurnUsage([
      activity("usage-1", "turn-1", "turn.usage"),
      activity("usage-bad", "turn-bad", "turn.usage", { inputTokens: "lots" }),
      activity("tool-1", "turn-2", "tool.updated"),
    ]);

    expect(derived.byTurnId.get("turn-1")).toEqual({ usage, model: null });
    expect([...derived.byTurnId.keys()]).toEqual(["turn-1"]);
  });

  it("reads the model a turn ran on, with or without its usage", () => {
    const model = { instanceId: "codex", model: "gpt-6.1-sol", effort: "medium" };
    const derived = deriveTurnUsage([
      activity("usage-1", "turn-1", "turn.usage", { ...usage, ...model }),
      activity("usage-2", "turn-2", "turn.usage", { model: "cursor-auto" }),
    ]);

    expect(derived.byTurnId.get("turn-1")).toEqual({ usage, model });
    expect(derived.byTurnId.get("turn-2")).toEqual({
      usage: null,
      model: { model: "cursor-auto" },
    });
  });

  it("keeps its identity until a usage activity arrives", () => {
    const first = deriveTurnUsage([activity("usage-1", "turn-1", "turn.usage")]);
    const streamed = deriveTurnUsage(
      [activity("usage-1", "turn-1", "turn.usage"), activity("tool-1", "turn-2", "tool.updated")],
      first,
    );
    const finished = deriveTurnUsage(
      [activity("usage-1", "turn-1", "turn.usage"), activity("usage-2", "turn-2", "turn.usage")],
      first,
    );

    expect(streamed).toBe(first);
    expect(finished).not.toBe(first);
    expect(finished.byTurnId.has("turn-2")).toBe(true);
  });

  it("takes the thread total from the newest record, not the last in sequence order", () => {
    // A new provider session restarts sequences, so the newer record can sort first.
    const derived = deriveTurnUsage([
      activity(
        "usage-3",
        "turn-3",
        "turn.usage",
        { ...usage, thread: threadTotal },
        "2026-01-03T00:00:00.000Z",
      ),
      activity(
        "usage-2",
        "turn-2",
        "turn.usage",
        { ...usage, thread: { ...threadTotal, countedTurns: 2 } },
        "2026-01-02T00:00:00.000Z",
      ),
    ]);

    expect(derived.thread).toEqual(threadTotal);
    expect(derived.byTurnId.get("turn-3")?.usage?.inputTokens).toBe(1_000_000);
  });

  it("has no thread total while the newest record predates totals", () => {
    const derived = deriveTurnUsage([
      activity(
        "usage-1",
        "turn-1",
        "turn.usage",
        { ...usage, thread: threadTotal },
        "2026-01-01T00:00:00.000Z",
      ),
      activity("usage-2", "turn-2", "turn.usage", usage, "2026-01-02T00:00:00.000Z"),
    ]);

    expect(derived.thread).toBeNull();
  });
});

describe("sumThreadTokenUsage", () => {
  it("adds every recorded turn, including records written before totals", () => {
    const total = sumThreadTokenUsage({
      activities: [
        activity("usage-1", "turn-1", "turn.usage"),
        activity("usage-2", "turn-2", "turn.usage", {
          usageScope: "main_agent",
          usageStatus: "partial",
          outputTokens: 1_000,
          hasSubagents: true,
        }),
      ],
      turnId: "turn-4",
      usage,
      turns: 4,
    });

    expect(total).toEqual({
      inputTokens: 2_000_000,
      cachedInputTokens: 1_200_000,
      cacheCreationTokens: 0,
      outputTokens: 101_000,
      reasoningTokens: 40_000,
      countedTurns: 3,
      turns: 4,
      partialTurns: 1,
      subagentTurns: 1,
      subagentTokens: 0,
      costUsd: 0,
      pricedTurns: 0,
    });
  });

  it("adds the cost of the turns that have one", () => {
    const total = sumThreadTokenUsage({
      activities: [
        activity("usage-1", "turn-1", "turn.usage", { ...usage, costUsd: 1.25 }),
        activity("usage-2", "turn-2", "turn.usage"),
      ],
      turnId: "turn-3",
      usage: { ...usage, costUsd: 0.5 },
      turns: 3,
    });

    expect(total).toMatchObject({ costUsd: 1.75, pricedTurns: 2, countedTurns: 3 });
  });

  it("adds reported subagent usage and counts only turns missing it", () => {
    const total = sumThreadTokenUsage({
      activities: [activity("usage-1", "turn-1", "turn.usage", { ...usage, hasSubagents: true })],
      turnId: "turn-2",
      usage: {
        ...usage,
        hasSubagents: true,
        subagents: { inputTokens: 400_000, cachedInputTokens: 300_000, outputTokens: 8_000 },
      },
      turns: 2,
    });

    expect(total).toMatchObject({
      inputTokens: 2_400_000,
      cachedInputTokens: 1_500_000,
      outputTokens: 108_000,
      subagentTurns: 1,
      subagentTokens: 408_000,
    });
  });

  it("leaves out a turn that reported no usage", () => {
    const total = sumThreadTokenUsage({
      activities: [activity("usage-1", "turn-1", "turn.usage")],
      turnId: "turn-2",
      usage: null,
      turns: 2,
    });

    expect(total).toMatchObject({ inputTokens: 1_000_000, countedTurns: 1, turns: 2 });
  });

  it("counts a turn once when it is recorded again", () => {
    const total = sumThreadTokenUsage({
      activities: [activity("usage-1", "turn-1", "turn.usage", { ...usage, inputTokens: 5 })],
      turnId: "turn-1",
      usage,
      turns: 1,
    });

    expect(total.inputTokens).toBe(1_000_000);
    expect(total.countedTurns).toBe(1);
  });
});

describe("turnUsageView", () => {
  it("folds reported subagent usage into the figure and shows its share", () => {
    const view = turnUsageView({
      ...usage,
      hasSubagents: true,
      subagents: { inputTokens: 200_000, outputTokens: 10_000, reasoningTokens: 4_000 },
    });

    expect(view).toEqual({
      headline: "1.26M tokens",
      rows: [
        { label: "Input", value: "1.20M (50% cached)" },
        { label: "Output", value: "60K (24K reasoning)" },
        { label: "Subagents", value: "210K" },
      ],
      notes: [],
    });
  });

  it("leads with total tokens and details the cached share and reasoning", () => {
    expect(turnUsageView(usage)).toEqual({
      headline: "1.05M tokens",
      rows: [
        { label: "Input", value: "1M (60% cached)" },
        { label: "Output", value: "50K (20K reasoning)" },
      ],
      notes: [],
    });
  });

  it("notes usage the figure leaves out", () => {
    const view = turnUsageView({
      usageScope: "main_agent",
      usageStatus: "partial",
      outputTokens: 900,
      cacheCreationTokens: 40_000,
      hasSubagents: true,
    });

    expect(view.headline).toBe("900 tokens");
    expect(view.rows).toContainEqual({ label: "Cache writes", value: "40K" });
    expect(view.notes).toEqual([
      "Subagent usage isn't included.",
      "The provider reported only some token counts.",
    ]);
  });
});

describe("cost", () => {
  it("adds an estimated API cost row, keeping sub-cent costs visible", () => {
    expect(turnUsageView({ ...usage, costUsd: 0.8412 }).rows.at(-1)).toEqual({
      label: "Est. API cost",
      value: "$0.84",
    });
    expect(turnUsageView({ ...usage, costUsd: 0.0031 }).rows.at(-1)?.value).toBe("<$0.01");
    expect(turnUsageView(usage).rows.map((row) => row.label)).not.toContain("Est. API cost");
  });

  it("says how many turns the thread's cost covers", () => {
    const view = threadUsageView({ ...threadTotal, costUsd: 4.2, pricedTurns: 2 });

    expect(view.rows.at(-1)).toEqual({ label: "Est. API cost", value: "$4.20" });
    expect(view.notes).toEqual(["Cost covers 2 of 3 turns."]);
    expect(threadUsageView({ ...threadTotal, costUsd: 0, pricedTurns: 0 }).rows).toHaveLength(2);
  });
});

describe("threadUsageView", () => {
  it("shows the same breakdown as a turn and stays quiet when every turn counts", () => {
    expect(threadUsageView(threadTotal)).toEqual({
      headline: "3.12M tokens",
      rows: [
        { label: "Input", value: "3M (67% cached)" },
        { label: "Output", value: "120K (40K reasoning)" },
      ],
      notes: [],
    });
  });

  it("says how many turns the total leaves out", () => {
    const view = threadUsageView({ ...threadTotal, turns: 5, partialTurns: 1, subagentTurns: 2 });

    expect(view.notes).toEqual([
      "Includes 3 of 5 turns.",
      "Subagent usage isn't included.",
      "Some turns reported only some token counts.",
    ]);
  });

  it("shows the subagents' share and says when only some turns reported it", () => {
    const view = threadUsageView({ ...threadTotal, subagentTurns: 1, subagentTokens: 900_000 });

    expect(view.rows).toContainEqual({ label: "Subagents", value: "900K" });
    expect(view.notes).toEqual(["Some turns' subagent usage isn't included."]);
  });
});

describe("turnModelLabel", () => {
  const sol: ServerProviderModel = {
    slug: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "medium", label: "Medium" },
            { id: "xhigh", label: "Extra High" },
          ],
        },
      ],
    },
  };
  const providers = [
    { instanceId: ProviderInstanceId.make("codex"), models: [sol] },
    {
      instanceId: ProviderInstanceId.make("codex-work"),
      models: [{ ...sol, name: "GPT-6.1 Sol (Work)" }],
    },
  ];

  it("names the model and effort as the composer does", () => {
    expect(
      turnModelLabel(
        { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol", effort: "xhigh" },
        providers,
      ),
    ).toBe("GPT-6.1 Sol (Extra High)");
  });

  it("prefers the turn's own provider instance", () => {
    expect(
      turnModelLabel(
        { instanceId: ProviderInstanceId.make("codex-work"), model: "gpt-6.1-sol" },
        providers,
      ),
    ).toBe("GPT-6.1 Sol (Work)");
  });

  it("keeps the provider's ids for a model that is no longer listed", () => {
    expect(turnModelLabel({ model: "gpt-5-retired", effort: "high" }, providers)).toBe(
      "gpt-5-retired (high)",
    );
  });
});
