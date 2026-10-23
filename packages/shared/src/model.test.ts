import { type ServerProviderModel } from "@t3tools/contracts";
import { normalizeAntigravityModelSelection } from "./model.ts";
import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type ModelCapabilities } from "@t3tools/contracts";

import {
  applyClaudePromptEffortPrefix,
  buildExplicitProviderOptionSelectionsFromDescriptors,
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  formatCodexModelName,
  formatModelSlugName,
  getProviderOptionCurrentLabel,
  getProviderOptionDescriptors,
  readCustomModelEntries,
  modelSelectionsEqual,
} from "./model.ts";

it("keeps the Codex catalog display formatting", () => {
  expect(formatCodexModelName("gpt-5.3-codex-spark")).toBe("GPT-5.3 Codex Spark");
  expect(formatCodexModelName("GPT-6.1-Sol")).toBe("GPT-6.1 Sol");
  expect(formatCodexModelName("GPT Test")).toBe("GPT Test");
});

it.each([
  ["gpt-5.4", "GPT-5.4"],
  ["claude-opus-4-6", "Claude Opus 4.6"],
  ["claude-sonnet-4-20250514", "Claude Sonnet 4 20250514"],
  ["claude-opus-4-6[1m]", "Claude Opus 4.6[1m]"],
  ["openai/gpt-5.4-mini", "openai/GPT-5.4 Mini"],
  ["gemini-2.5-pro-preview-06-05", "Gemini 2.5 Pro Preview 06 05"],
  ["custom/model-v2", "custom/model-v2"],
  ["gpt-proxy", "gpt-proxy"],
  ["My Custom Model", "My Custom Model"],
])("formats a known model ID without losing its qualifiers: %s", (slug, expected) => {
  expect(formatModelSlugName(slug)).toBe(expected);
});

const codexCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "xhigh", label: "Extra High" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    },
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

const claudeCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
        { id: "ultrathink", label: "Ultrathink" },
      ],
      currentValue: "high",
      promptInjectedValues: ["ultrathink"],
    },
    {
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [
        { id: "200k", label: "200k" },
        { id: "1m", label: "1M", isDefault: true },
      ],
      currentValue: "1m",
    },
  ],
});

describe("descriptor helpers", () => {
  it("builds dispatch options only from explicit selections", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [{ id: "fastMode", value: true }],
    });

    expect(buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, undefined)).toBe(
      undefined,
    );
    expect(
      buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, [
        { id: "fastMode", value: true },
      ]),
    ).toEqual([{ id: "fastMode", value: true }]);
  });

  it("compares complete model selections independent of option ordering", () => {
    const left = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
    const reordered = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "fastMode", value: true },
      { id: "reasoningEffort", value: "high" },
    ]);

    expect(modelSelectionsEqual(left, reordered)).toBe(true);
    expect(
      modelSelectionsEqual(left, {
        ...reordered,
        options: [
          { id: "fastMode", value: true },
          { id: "reasoningEffort", value: "medium" },
        ],
      }),
    ).toBe(false);
    expect(modelSelectionsEqual(left, { ...reordered, model: "gpt-5.5" })).toBe(false);
  });
});

describe("applyClaudePromptEffortPrefix", () => {
  it("keeps slash commands intact when ultrathink is selected", () => {
    expect(applyClaudePromptEffortPrefix("/compact", "ultrathink")).toBe("/compact");
    expect(applyClaudePromptEffortPrefix(" /compact keep recent errors ", "ultrathink")).toBe(
      "/compact keep recent errors",
    );
    expect(applyClaudePromptEffortPrefix(" /review src/model.ts ", "ultrathink")).toBe(
      "/review src/model.ts",
    );
    expect(applyClaudePromptEffortPrefix("/security-review", "ultrathink")).toBe(
      "/security-review",
    );
    expect(applyClaudePromptEffortPrefix("/plugin:skill run", "ultrathink")).toBe(
      "/plugin:skill run",
    );
    expect(applyClaudePromptEffortPrefix("/deploy.prod to staging", "ultrathink")).toBe(
      "/deploy.prod to staging",
    );
  });

  it("still adds the ultrathink prefix to ordinary prompts", () => {
    expect(applyClaudePromptEffortPrefix("Investigate this failure", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate this failure",
    );
    expect(applyClaudePromptEffortPrefix("/home/theo/app.ts crashed on load", "ultrathink")).toBe(
      "Ultrathink:\n/home/theo/app.ts crashed on load",
    );
  });
});

describe("readCustomModelEntries", () => {
  const capabilities: ModelCapabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
        currentValue: "high",
      },
    ],
  };

  it("resolves bare slugs and entries, trimming and deduplicating on slug", () => {
    expect(
      readCustomModelEntries([
        " bare ",
        { slug: "named", name: " Named ", capabilities },
        "bare",
        { slug: "named", name: "Second" },
        "",
        { name: "no slug" },
        42,
      ]),
    ).toEqual([
      { slug: "bare", name: "bare", capabilities: null },
      { slug: "named", name: "Named", capabilities },
    ]);
  });

  it("drops unparseable capabilities but keeps the entry", () => {
    expect(
      readCustomModelEntries([{ slug: "x", capabilities: { optionDescriptors: "nope" } }]),
    ).toEqual([{ slug: "x", name: "x", capabilities: null }]);
    expect(readCustomModelEntries("not a list")).toEqual([]);
  });
});

describe("Antigravity grouped selections", () => {
  const models = ["flash", "pro"].map((family): ServerProviderModel => ({
    slug: `gemini-9.1-${family}`,
    name: `Gemini 9.1 ${family}`,
    isCustom: false,
    aliases: [`${family}-native`, `${family}-low`],
    capabilities: {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning effort",
          type: "select",
          currentValue: `${family}-native`,
          options: [
            { id: `${family}-native`, label: "High", isDefault: true },
            { id: `${family}-low`, label: "Low" },
          ],
        },
      ],
    },
  }));
  const instanceId = ProviderInstanceId.make("antigravity-work");
  it("recovers exact effort from legacy IDs including IDs without effort suffixes", () => {
    for (const [native, model] of [
      ["flash-low", "gemini-9.1-flash"],
      ["pro-native", "gemini-9.1-pro"],
    ]) {
      expect(normalizeAntigravityModelSelection({ instanceId, model: native! }, models)).toEqual({
        instanceId,
        model,
        options: [{ id: "reasoningEffort", value: native }],
      });
    }
  });
  it("carries effort to the new model's native choice when changing families", () => {
    expect(
      normalizeAntigravityModelSelection(
        {
          instanceId,
          model: "gemini-9.1-pro",
          options: [{ id: "reasoningEffort", value: "flash-low" }],
        },
        models,
      ),
    ).toEqual({
      instanceId,
      model: "gemini-9.1-pro",
      options: [{ id: "reasoningEffort", value: "pro-low" }],
    });
  });
  it("retains missing models and choices instead of changing their effort", () => {
    const selection = { instanceId, model: "removed-native" };
    expect(normalizeAntigravityModelSelection(selection, models)).toBe(selection);
    const invalid = {
      instanceId,
      model: "gemini-9.1-pro",
      options: [{ id: "reasoningEffort", value: "removed-effort" }],
    };
    expect(normalizeAntigravityModelSelection(invalid, models)).toBe(invalid);
  });
});

describe("provider-reported option display", () => {
  const selection = createModelSelection(ProviderInstanceId.make("opencode"), "ling");
  const reported = { ...selection, options: [{ id: "variant", value: "default" }] };
  const descriptor = {
    id: "variant",
    label: "Reasoning",
    type: "select" as const,
    options: [
      { id: "none", label: "None" },
      { id: "thinking", label: "Thinking" },
    ],
  };

  it("shows explicit reports without adding a choice or a dispatch option", () => {
    expect(getProviderOptionCurrentLabel(descriptor, selection, reported)).toBe("Default");
    expect(
      getProviderOptionCurrentLabel(descriptor, selection, {
        ...reported,
        options: [{ id: "variant", value: "thinking" }],
      }),
    ).toBe("Thinking");
    expect(
      getProviderOptionCurrentLabel(
        { ...descriptor, currentValue: "none" },
        { ...selection, options: [{ id: "variant", value: "none" }] },
        reported,
      ),
    ).toBe("None");
    expect(descriptor.options.map((option) => option.id)).toEqual(["none", "thinking"]);
    expect(buildProviderOptionSelectionsFromDescriptors([descriptor])).toBeUndefined();
    expect(getProviderOptionCurrentLabel(descriptor, selection)).toBe("Unknown");
    const effortDescriptor = { ...descriptor, id: "effort", currentValue: "default" };
    expect(getProviderOptionCurrentLabel(effortDescriptor, selection)).toBeUndefined();
    expect(
      getProviderOptionCurrentLabel(effortDescriptor, selection, {
        ...reported,
        model: "other",
        options: [{ id: "effort", value: "default" }],
      }),
    ).toBeUndefined();
    expect(
      getProviderOptionCurrentLabel(effortDescriptor, selection, {
        ...reported,
        options: [{ id: "effort", value: "default" }],
      }),
    ).toBe("Default");
    expect(
      getProviderOptionCurrentLabel({ ...descriptor, currentValue: "thinking" }, selection),
    ).toBe("Unknown");
  });

  it.each([
    { ...selection, model: "other" },
    { ...selection, instanceId: ProviderInstanceId.make("other") },
    { ...selection, options: [{ id: "variant", value: "none" }] },
  ])("ignores reports after changing the model, instance, or option: %j", (selected) => {
    expect(getProviderOptionCurrentLabel(descriptor, selected, reported)).toBe("Unknown");
  });
});
