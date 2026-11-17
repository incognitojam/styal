import {
  type ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { claudeSelectionCacheLoss, resolveCacheLossBaseline } from "./ContextWindowMeter.logic";
import { resumesClaudeSession } from "./claudeSessionResume";

const claudeEntry = (instanceId: string, continuationGroupKey?: string) => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driverKind: ProviderDriverKind.make("claudeAgent"),
  continuationGroupKey,
});
const codexEntry = {
  instanceId: ProviderInstanceId.make("codex"),
  driverKind: ProviderDriverKind.make("codex"),
  continuationGroupKey: undefined,
};

describe("resumesClaudeSession", () => {
  it("resumes the same instance and instances that share its history", () => {
    const shared = [claudeEntry("claudeAgent", "home:/a"), claudeEntry("work", "home:/a")];
    expect(resumesClaudeSession(shared, shared[0]!.instanceId, shared[0])).toBe(true);
    expect(resumesClaudeSession(shared, shared[0]!.instanceId, shared[1])).toBe(true);
  });

  it("hands off between providers and to a Claude instance with separate history", () => {
    const claude = claudeEntry("claudeAgent", "home:/a");
    const other = claudeEntry("other", "home:/b");
    const ungrouped = claudeEntry("ungrouped");
    const entries = [claude, other, ungrouped, codexEntry];
    expect(resumesClaudeSession(entries, codexEntry.instanceId, claude)).toBe(false);
    expect(resumesClaudeSession(entries, claude.instanceId, codexEntry)).toBe(false);
    expect(resumesClaudeSession(entries, claude.instanceId, other)).toBe(false);
    expect(resumesClaudeSession(entries, ungrouped.instanceId, claudeEntry("ungrouped-2"))).toBe(
      false,
    );
  });

  it("does not resume when the thread's instance is no longer configured", () => {
    const claude = claudeEntry("claudeAgent");
    expect(resumesClaudeSession([claude], ProviderInstanceId.make("removed"), claude)).toBe(false);
  });
});

describe("claudeSelectionCacheLoss", () => {
  const claude = ProviderInstanceId.make("claudeAgent");
  const capabilities: ModelCapabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
        ],
      },
      { id: "fastMode", label: "Fast Mode", type: "boolean" },
    ],
  };
  const selection = (model: string, options?: ModelSelection["options"]): ModelSelection => ({
    instanceId: claude,
    model,
    ...(options ? { options } : {}),
  });
  const warmThread = {
    provider: "claudeAgent",
    capabilities,
    usedTokens: 200_000,
    updatedAt: "2026-08-24T11:30:00.000Z",
    now: "2026-08-24T12:00:00.000Z",
  };

  it("reports a model switch", () => {
    expect(
      claudeSelectionCacheLoss({
        ...warmThread,
        current: selection("claude-sonnet-5"),
        next: selection("claude-opus-5-5"),
      }),
    ).toBe("model");
  });

  it.each(["claude-sonnet-5", "claude-opus-4-8"])(
    "reports an effort change on a per-request model: %s",
    (model) => {
      expect(
        claudeSelectionCacheLoss({
          ...warmThread,
          current: selection(model, [{ id: "effort", value: "high" }]),
          next: selection(model, [{ id: "effort", value: "medium" }]),
        }),
      ).toBe("effort");
    },
  );

  it.each([
    "claude-opus-5-5",
    "claude-fable-5",
    "claude-fable-5-1",
    "claude-fable-5-2",
    "claude-haiku-5-5",
    "claude-sonnet-5-5",
    "claude-future",
  ])("allows an effort change without per-request evidence: %s", (model) => {
    expect(
      claudeSelectionCacheLoss({
        ...warmThread,
        current: selection(model, [{ id: "effort", value: "high" }]),
        next: selection(model, [{ id: "effort", value: "medium" }]),
      }),
    ).toBeNull();
  });

  it("reports toggling fast mode, even on a model that sends effort per turn", () => {
    expect(
      claudeSelectionCacheLoss({
        ...warmThread,
        current: selection("claude-opus-5-5"),
        next: selection("claude-opus-5-5", [{ id: "fastMode", value: true }]),
      }),
    ).toBe("fastMode");
  });

  it("treats an explicit default as no change", () => {
    expect(
      claudeSelectionCacheLoss({
        ...warmThread,
        current: selection("claude-sonnet-5"),
        next: selection("claude-sonnet-5", [
          { id: "effort", value: "high" },
          { id: "fastMode", value: false },
        ]),
      }),
    ).toBeNull();
  });

  it("stays quiet once the cache has expired, for small contexts, and for other providers", () => {
    const change = {
      current: selection("claude-sonnet-5"),
      next: selection("claude-opus-5-5"),
    };
    expect(
      claudeSelectionCacheLoss({ ...warmThread, ...change, updatedAt: "2026-08-24T11:00:00.000Z" }),
    ).toBeNull();
    expect(claudeSelectionCacheLoss({ ...warmThread, ...change, usedTokens: 199_999 })).toBeNull();
    expect(claudeSelectionCacheLoss({ ...warmThread, ...change, provider: "codex" })).toBeNull();
  });
});

describe("resolveCacheLossBaseline", () => {
  it("uses inherited context before a side chat starts, then the last started selection rather than a queued choice", () => {
    const inheritedSelection = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-5",
    };
    const sent = { ...inheritedSelection, options: [{ id: "effort", value: "high" }] };
    const queued = { ...inheritedSelection, options: [{ id: "effort", value: "medium" }] };
    expect(resolveCacheLossBaseline({ runs: [], inheritedSelection })).toEqual(inheritedSelection);
    expect(
      resolveCacheLossBaseline({
        runs: [
          { startedAt: "sent", modelSelection: sent },
          { startedAt: null, modelSelection: queued },
        ],
        inheritedSelection: queued,
      }),
    ).toEqual(sent);
  });
});
