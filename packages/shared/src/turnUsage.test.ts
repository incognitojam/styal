import {
  EventId,
  NodeId,
  RunId,
  ProviderInstanceId,
  TurnId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type UsageActivity,
  addTurnTokenUsage,
  deriveTurnUsage,
  deriveProjectionTurnUsage,
  sumThreadTokenUsage,
  threadUsageView,
  turnModelLabel,
  meterWheels,
  turnUsageView,
  threadUsageSummary,
  usageFigureShown,
  usageFigureText,
  withLiveTurnUsage,
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
): UsageActivity {
  return {
    id: EventId.make(id),
    kind,
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

describe("addTurnTokenUsage", () => {
  it("combines native turns within one run without losing subagent counts or recorded cost", () => {
    expect(
      addTurnTokenUsage(
        {
          ...usage,
          inputTokens: 100,
          outputTokens: 10,
          cachedInputTokens: 40,
          reasoningTokens: 2,
          hasSubagents: true,
          subagents: { inputTokens: 20, outputTokens: 3 },
          costUsd: 0.125,
        },
        {
          usageScope: "main_agent",
          usageStatus: "partial",
          hasSubagents: false,
          inputTokens: 200,
          outputTokens: 30,
          costUsd: 0.25,
        },
      ),
    ).toEqual({
      usageScope: "main_agent",
      usageStatus: "partial",
      hasSubagents: true,
      inputTokens: 300,
      outputTokens: 40,
      cachedInputTokens: 40,
      reasoningTokens: 2,
      subagents: { inputTokens: 20, outputTokens: 3 },
      costUsd: 0.375,
    });
  });

  it("keeps a run unpriced when one native turn has no recorded cost", () => {
    const combined = addTurnTokenUsage({ ...usage, costUsd: 0.25 }, usage);
    expect(combined.costUsd).toBeUndefined();
    expect(combined.inputTokens).toBe(2_000_000);
    expect(combined.outputTokens).toBe(100_000);
  });
});

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
      costUsd: null,
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
      costUsd: null,
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

describe("usageFigureText", () => {
  it("leads with cost when chosen and known, and tokens otherwise", () => {
    const priced = turnUsageView({ ...usage, costUsd: 0.8412 });

    expect(usageFigureText(priced, "cost")).toBe("$0.84");
    expect(usageFigureText(priced, "tokens")).toBe("1.05M tokens");
    expect(usageFigureText(turnUsageView(usage), "cost")).toBe("1.05M tokens");
    expect(
      usageFigureText(threadUsageView({ ...threadTotal, costUsd: 0, pricedTurns: 0 }), "cost"),
    ).toBe("3.12M tokens");
    expect(usageFigureShown(priced, "cost")).toBe("cost");
    expect(usageFigureShown(turnUsageView(usage), "cost")).toBe("tokens");
  });
});

describe("withLiveTurnUsage", () => {
  it("adds a running turn to the thread's total as one more counted turn", () => {
    const live = { ...usage, costUsd: 0.5 };

    expect(withLiveTurnUsage({ ...threadTotal, costUsd: 2, pricedTurns: 3 }, live)).toEqual({
      ...threadTotal,
      inputTokens: 4_000_000,
      cachedInputTokens: 2_600_000,
      outputTokens: 170_000,
      reasoningTokens: 60_000,
      countedTurns: 4,
      turns: 4,
      subagentTokens: 0,
      costUsd: 2.5,
      pricedTurns: 4,
    });
    // The first turn of a thread is its whole total.
    expect(threadUsageView(withLiveTurnUsage(null, live)).headline).toBe("1.05M tokens");
    expect(withLiveTurnUsage(null, { ...usage, usageStatus: "partial" })).toMatchObject({
      countedTurns: 1,
      partialTurns: 0,
      pricedTurns: 0,
    });
  });
});

describe("threadUsageSummary", () => {
  it("says what a cost is, and falls back to tokens without one", () => {
    expect(threadUsageSummary({ ...threadTotal, costUsd: 2.124, pricedTurns: 3 }, "cost")).toBe(
      "$2.12 est. API cost",
    );
    expect(threadUsageSummary({ ...threadTotal, costUsd: 2.124, pricedTurns: 3 }, "tokens")).toBe(
      "3.12M tokens",
    );
    expect(threadUsageSummary(threadTotal, "cost")).toBe("3.12M tokens");
  });
});

describe("meterWheels", () => {
  const rolling = (previous: string, text: string) =>
    meterWheels(previous, text)
      .filter((wheel) => wheel.rolls)
      .map((wheel) => `${wheel.before ?? "_"}>${wheel.text}@${wheel.position}#${wheel.order}`);

  it("rolls each changed digit, lined up from the right, rightmost first", () => {
    expect(rolling("$0.84", "$0.97")).toEqual(["8>9@1#1", "4>7@0#0"]);
    expect(rolling("4.64M tokens", "4.71M tokens")).toEqual(["6>7@9#1", "4>1@8#0"]);
    expect(rolling("$1.23", "$1.23")).toEqual([]);
  });

  it("rolls a new leading digit in from blank and leaves symbols in place", () => {
    expect(rolling("$9.99", "$10.01")).toEqual(["_>1@4#3", "9>0@3#2", "9>0@1#1", "9>1@0#0"]);
    expect(rolling("$0.01", "$10.01")).toEqual(["_>1@4#0"]);
    // A symbol that goes away just goes; only the digit rolls.
    expect(rolling("<$0.01", "$0.02")).toEqual(["1>2@0#0"]);
  });

  it("rolls the number and unit together when the reading changes shape", () => {
    expect(rolling("998K tokens", "1.00M tokens")).toEqual(["998K>1.00M@7#0"]);
    expect(rolling("98.9K tokens", "103K tokens")).toEqual(["98.9>103@8#0"]);
    expect(
      meterWheels("998K tokens", "1.00M tokens")
        .map((wheel) => wheel.text)
        .join(""),
    ).toBe("1.00M tokens");
  });
});

describe("threadUsageView", () => {
  it("shows the same breakdown as a turn and stays quiet when every turn counts", () => {
    expect(threadUsageView(threadTotal)).toEqual({
      headline: "3.12M tokens",
      costUsd: null,
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

it("prefers newer live root usage and excludes child and rolled-back records", () => {
  const run = (id: string, ordinal: number, status: "completed" | "running" | "rolled_back") => ({
    id: RunId.make(id),
    ordinal,
    status,
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
    },
  });
  const node = (id: string, runId: string, kind: "root_turn" | "subagent") => ({
    id: NodeId.make(id),
    runId: RunId.make(runId),
    kind,
  });
  const total = (inputTokens: number) =>
    sumThreadTokenUsage({
      activities: [],
      turnId: "total",
      turns: 1,
      usage: { ...usage, inputTokens },
    });
  const turn = (id: string, ordinal: number, inputTokens: number) => ({
    nodeId: NodeId.make(id),
    ordinal,
    turnTokenUsage: { ...usage, inputTokens },
    threadTokenUsage: total(inputTokens),
  });
  const result = deriveProjectionTurnUsage({
    runs: [
      run("done", 1, "completed"),
      run("live", 2, "running"),
      run("rollback", 3, "rolled_back"),
    ],
    nodes: [
      node("done-node", "done", "root_turn"),
      node("live-node", "live", "root_turn"),
      node("child", "live", "subagent"),
      node("rollback-node", "rollback", "root_turn"),
    ],
    providerTurns: [
      turn("done-node", 99, 10),
      turn("live-node", 1, 20),
      turn("child", 100, 900),
      turn("rollback-node", 101, 1000),
    ],
  });
  expect(result.thread?.inputTokens).toBe(20);
  expect([...result.byTurnId.keys()]).toEqual(["done", "live"]);
  expect(result.byTurnId.get("live")?.usage?.inputTokens).toBe(20);
});
