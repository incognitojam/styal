import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

import { canApplyClaudeEffortLive, compileClaudeModelSelection } from "./claudeModelOptions.ts";

const selection = (
  model: string,
  options: NonNullable<ModelSelection["options"]>,
): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claude_test"),
  model,
  options,
});

describe("compileClaudeModelSelection", () => {
  it("compiles context, effort, and settings together", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-opus-4-6", [
          { id: "contextWindow", value: "1m" },
          { id: "effort", value: "max" },
          { id: "fastMode", value: true },
        ]),
      ),
    ).toMatchObject({
      apiModelId: "claude-opus-4-6[1m]",
      effort: "max",
      settings: { fastMode: true },
    });
  });

  it("compiles fast mode only for models that expose it", () => {
    expect(
      compileClaudeModelSelection(selection("claude-opus-4-6", [{ id: "fastMode", value: true }]))
        .settings,
    ).toEqual({ fastMode: true });
    expect(
      compileClaudeModelSelection(selection("claude-opus-4-6", [{ id: "fastMode", value: false }]))
        .settings,
    ).toEqual({ fastMode: false });
  });

  it("uses the model default SDK effort alongside prompt-injected effort", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-sonnet-4-6", [{ id: "effort", value: "ultrathink" }]),
      ),
    ).toMatchObject({ effort: "high", promptEffort: "ultrathink" });
  });

  it("compiles the thinking toggle for models that expose it", () => {
    expect(
      compileClaudeModelSelection(selection("claude-haiku-4-5", [{ id: "thinking", value: false }]))
        .settings,
    ).toEqual({ alwaysThinkingEnabled: false });
  });
});

describe("canApplyClaudeEffortLive", () => {
  it("allows only effort changes that both resolve to native API effort", () => {
    const before = selection("claude-opus-4-6", [{ id: "effort", value: "low" }]);
    expect(
      canApplyClaudeEffortLive(before, selection(before.model, [{ id: "effort", value: "high" }])),
    ).toBe(true);
    expect(
      canApplyClaudeEffortLive(
        before,
        selection(before.model, [{ id: "effort", value: "ultracode" }]),
      ),
    ).toBe(false);
    expect(
      canApplyClaudeEffortLive(
        before,
        selection(before.model, [
          { id: "effort", value: "high" },
          { id: "fastMode", value: true },
        ]),
      ),
    ).toBe(false);
    expect(
      canApplyClaudeEffortLive(
        before,
        selection("claude-haiku-4-5", [{ id: "effort", value: "high" }]),
      ),
    ).toBe(false);
    const haiku = selection("claude-haiku-4-5", [{ id: "effort", value: "low" }]);
    expect(
      canApplyClaudeEffortLive(haiku, selection(haiku.model, [{ id: "effort", value: "high" }])),
    ).toBe(false);
  });
});
