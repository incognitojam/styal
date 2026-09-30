import { describe, expect, it } from "vite-plus/test";

import {
  currentEffortDialLevel,
  EFFORT_DIAL_LEVELS,
  resolveEffortDialLevel,
  type EffortDialContext,
  type EffortDialModel,
} from "./effortDial.ts";

const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultracode"];

const codexModels: ReadonlyArray<EffortDialModel> = [
  { instanceId: "codex", driver: "codex", model: "gpt-6.1-sol", efforts: CODEX_EFFORTS },
  { instanceId: "codex", driver: "codex", model: "gpt-6-sol", efforts: CODEX_EFFORTS },
  { instanceId: "codex", driver: "codex", model: "gpt-6-astra", efforts: CODEX_EFFORTS },
  { instanceId: "codex", driver: "codex", model: "gpt-6-luna", efforts: ["low", "medium", "high"] },
];
const claudeModels: ReadonlyArray<EffortDialModel> = [
  {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    model: "claude-opus-5-5",
    efforts: CLAUDE_EFFORTS,
  },
  {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    model: "claude-fable-5-1",
    efforts: CLAUDE_EFFORTS,
  },
  {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    model: "claude-sonnet-5-5",
    efforts: CLAUDE_EFFORTS,
  },
];

const context = (overrides: Partial<EffortDialContext>): EffortDialContext => ({
  models: [...codexModels, ...claudeModels],
  lockedDriver: null,
  current: null,
  ...overrides,
});

const describeLevels = (input: EffortDialContext) =>
  EFFORT_DIAL_LEVELS.map((level) => {
    const target = resolveEffortDialLevel(level, input);
    return target ? `${level}: ${target.model} ${target.effort}` : `${level}: none`;
  });

describe("resolveEffortDialLevel", () => {
  it("spreads a new thread across both providers", () => {
    expect(describeLevels(context({}))).toEqual([
      "light: gpt-6.1-sol medium",
      "standard: claude-opus-5-5 medium",
      "deep: claude-opus-5-5 high",
      "ultra: claude-fable-5-1 high",
    ]);
  });

  it("uses one provider's column when only it is configured", () => {
    expect(describeLevels(context({ models: codexModels }))).toEqual([
      "light: gpt-6.1-sol low",
      "standard: gpt-6.1-sol medium",
      "deep: gpt-6.1-sol xhigh",
      "ultra: gpt-6-astra xhigh",
    ]);
    expect(describeLevels(context({ models: claudeModels }))).toEqual([
      "light: claude-sonnet-5-5 high",
      "standard: claude-opus-5-5 medium",
      "deep: claude-opus-5-5 high",
      "ultra: claude-fable-5-1 high",
    ]);
  });

  it("stays on the provider a started thread is locked to", () => {
    expect(describeLevels(context({ lockedDriver: "claudeAgent" }))).toEqual([
      "light: claude-sonnet-5-5 high",
      "standard: claude-opus-5-5 medium",
      "deep: claude-opus-5-5 high",
      "ultra: claude-fable-5-1 high",
    ]);
  });

  it("falls back when a CLI does not offer the newest model", () => {
    const olderCodex = codexModels.filter((model) => model.model !== "gpt-6.1-sol");
    expect(describeLevels(context({ models: olderCodex }))).toEqual([
      "light: gpt-6-sol medium",
      "standard: gpt-6-sol high",
      "deep: gpt-6-astra high",
      "ultra: gpt-6-astra xhigh",
    ]);
  });

  it("only changes effort on a model picked by hand that the tables do not cover", () => {
    expect(
      describeLevels(context({ current: { instanceId: "codex", model: "gpt-6-luna" } })),
    ).toEqual([
      "light: gpt-6-luna low",
      "standard: gpt-6-luna medium",
      "deep: gpt-6-luna high",
      // Luna has no xhigh, so ultra settles on the nearest lower effort.
      "ultra: gpt-6-luna high",
    ]);
  });

  it("keeps the selected instance when two instances offer the same model", () => {
    const personal: EffortDialModel = { ...codexModels[0]!, instanceId: "codex_personal" };
    const target = resolveEffortDialLevel(
      "light",
      context({
        models: [...codexModels, personal],
        current: { instanceId: "codex_personal", model: "gpt-6.1-sol" },
      }),
    );
    expect(target?.instanceId).toBe("codex_personal");
  });
});

describe("currentEffortDialLevel", () => {
  it("names the level that matches the selection exactly", () => {
    const input = context({ current: { instanceId: "claudeAgent", model: "claude-opus-5-5" } });
    expect(
      currentEffortDialLevel(
        { instanceId: "claudeAgent", model: "claude-opus-5-5", effort: "high" },
        input,
      ),
    ).toBe("deep");
    expect(
      currentEffortDialLevel(
        { instanceId: "claudeAgent", model: "claude-opus-5-5", effort: "max" },
        input,
      ),
    ).toBeNull();
  });
});
