import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveTurnUsage, turnUsageView } from "./turnUsage.ts";

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
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: "Turn usage",
    turnId: TurnId.make(turnId),
    createdAt: "2026-01-01T00:00:00.000Z",
    payload,
  };
}

describe("deriveTurnUsage", () => {
  it("indexes usage by turn and skips records it cannot read", () => {
    const derived = deriveTurnUsage([
      activity("usage-1", "turn-1", "turn.usage"),
      activity("usage-bad", "turn-bad", "turn.usage", { inputTokens: "lots" }),
      activity("tool-1", "turn-2", "tool.updated"),
    ]);

    expect(derived.byTurnId.get("turn-1")?.inputTokens).toBe(1_000_000);
    expect([...derived.byTurnId.keys()]).toEqual(["turn-1"]);
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
});

describe("turnUsageView", () => {
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
