import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { buildEffortDialModels, getEffortDialSpeedControl } from "./effortDial.logic";

const claudeOpus: ServerProviderModel = {
  slug: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium", isDefault: true },
          { id: "high", label: "High" },
          { id: "ultrathink", label: "Ultrathink" },
        ],
        promptInjectedValues: ["ultrathink"],
      },
      {
        id: "fastMode",
        label: "Fast Mode",
        type: "boolean",
        description: "Same model, faster output.",
      },
    ],
  },
};

const codexSol: ServerProviderModel = {
  slug: "gpt-6.1-sol",
  name: "GPT-6.1-Sol",
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low", isDefault: true },
          { id: "medium", label: "Medium" },
        ],
      },
      {
        id: "serviceTier",
        label: "Service Tier",
        type: "select",
        options: [
          { id: "default", label: "Standard", isDefault: true },
          { id: "priority", label: "Fast", description: "2x speed, increased usage" },
        ],
      },
    ],
  },
};

function provider(input: {
  instanceId: string;
  driver: string;
  models: ReadonlyArray<ServerProviderModel>;
  enabled?: boolean;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-30T12:00:00.000Z",
    models: [...input.models],
    slashCommands: [],
    skills: [],
  };
}

describe("buildEffortDialModels", () => {
  it("offers effort models on ready Codex and Claude instances only", () => {
    const entries = deriveProviderInstanceEntries([
      provider({ instanceId: "claudeAgent", driver: "claudeAgent", models: [claudeOpus] }),
      provider({ instanceId: "codex", driver: "codex", models: [codexSol] }),
      provider({ instanceId: "codex_off", driver: "codex", models: [codexSol], enabled: false }),
      provider({ instanceId: "cursor", driver: "cursor", models: [codexSol] }),
    ]);

    expect(buildEffortDialModels(entries)).toEqual([
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        model: "claude-opus-5-5",
        // Ultrathink is typed into the prompt, so the dial never picks it.
        efforts: ["low", "medium", "high"],
      },
      { instanceId: "codex", driver: "codex", model: "gpt-6.1-sol", efforts: ["low", "medium"] },
    ]);
  });
});

describe("getEffortDialSpeedControl", () => {
  it("maps Claude's fast mode and Codex's service tier to one speed choice", () => {
    const claude = getEffortDialSpeedControl(claudeOpus, [{ id: "fastMode", value: true }]);
    expect(claude?.value).toBe("fast");
    expect(claude?.toOptionValue("standard")).toBe(false);
    expect(claude?.choices[1]?.description).toBe("Same model, faster output.");

    const codex = getEffortDialSpeedControl(codexSol, undefined);
    expect(codex?.choices.map((choice) => choice.label)).toEqual(["Normal", "Fast"]);
    expect(codex?.value).toBe("default");
    expect(codex?.choices[1]?.description).toBe("2x speed, increased usage");
  });

  it("offers no speed control for a model without one", () => {
    const withoutSpeed: ServerProviderModel = {
      ...claudeOpus,
      capabilities: { optionDescriptors: claudeOpus.capabilities!.optionDescriptors!.slice(0, 1) },
    };
    expect(getEffortDialSpeedControl(withoutSpeed, undefined)).toBeNull();
  });
});
