import { assert, it } from "@effect/vitest";

import {
  applyPreferredCodexDefaultModel,
  codexServerRateLimits,
  isLegacyCodexModel,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

it("keeps only the GPT-5.6 Codex family out of legacy models", () => {
  assert.deepStrictEqual(
    ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.4"].map((model) => [
      model,
      isLegacyCodexModel(model),
    ]),
    [
      ["gpt-5.6-luna", false],
      ["gpt-5.6-terra", false],
      ["gpt-5.6-sol", false],
      ["gpt-5.4", true],
    ],
  );
});

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("flattens a single-limit rate limits read into canonical windows", () => {
  const rateLimits = codexServerRateLimits(
    {
      rateLimits: {
        credits: { balance: "0", hasCredits: false, unlimited: false },
        limitId: "codex",
        limitName: null,
        planType: "pro",
        primary: { resetsAt: 1_787_581_395, usedPercent: 3, windowDurationMins: 10_080 },
        secondary: null,
      },
    },
    "2026-01-01T00:00:00.000Z",
  );

  assert.deepStrictEqual(rateLimits, {
    windows: [{ id: "primary", usedPercent: 3, resetsAt: 1_787_581_395, windowMinutes: 10_080 }],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
});

it("ignores per-model named limits so the card shows only account quota", () => {
  const rateLimits = codexServerRateLimits(
    {
      rateLimits: {
        limitId: "codex",
        limitName: null,
        primary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: 1_787_581_395 },
        secondary: null,
      },
      // Backend key order here is not guaranteed, so a Spark quota could
      // otherwise render ahead of the account's own limit.
      rateLimitsByLimitId: {
        codex_bengalfox: {
          limitId: "codex_bengalfox",
          limitName: "GPT-5.3-Codex-Spark",
          primary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1_787_679_023 },
        },
        codex: {
          limitId: "codex",
          limitName: null,
          primary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: 1_787_581_395 },
        },
      },
    },
    "2026-01-01T00:00:00.000Z",
  );

  assert.deepStrictEqual(rateLimits, {
    windows: [{ id: "primary", usedPercent: 7, resetsAt: 1_787_581_395, windowMinutes: 10_080 }],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
});

it("reports no rate limits when the response has no windows", () => {
  assert.deepStrictEqual(
    codexServerRateLimits(
      { rateLimits: { primary: null, secondary: null } },
      "2026-01-01T00:00:00.000Z",
    ),
    undefined,
  );
  assert.deepStrictEqual(codexServerRateLimits(undefined, "2026-01-01T00:00:00.000Z"), undefined);
});
