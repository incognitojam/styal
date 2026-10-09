import { assert, describe, it } from "@effect/vitest";
import type { ServerProviderModel } from "@t3tools/contracts";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";

import { applyAntigravityModelCatalog } from "./antigravityModelCatalog.ts";

const model = (overrides: Partial<ServerProviderModel>): ServerProviderModel => ({
  slug: "model-test",
  name: "Model Test",
  isCustom: false,
  capabilities: null,
  ...overrides,
});

const draft = (models: ReadonlyArray<ServerProviderModel>) =>
  ({ models }) as unknown as ServerProviderDraft;

describe("applyAntigravityModelCatalog", () => {
  it("resolves native Antigravity defaults without moving other native aliases", () => {
    const models = [
      model({ slug: "old-group", isDefault: true, aliases: ["old-native", "antigravity-default"] }),
      model({
        slug: "new-group",
        isLegacy: true,
        aliases: ["native-high", "native-low"],
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning effort",
              type: "select",
              currentValue: "native-high",
              options: [
                { id: "native-high", label: "High", isDefault: true },
                { id: "native-low", label: "Low" },
              ],
            },
          ],
        },
      }),
    ];
    const resolved = applyAntigravityModelCatalog(draft(models), {
      models: [],
      defaultChatModel: "native-low",
    }).models;
    assert.deepStrictEqual(resolved[0]?.aliases, ["old-native"]);
    assert.strictEqual(resolved[0]?.isDefault, undefined);
    assert.deepStrictEqual(resolved[1]?.aliases, [
      "native-high",
      "native-low",
      "antigravity-default",
    ]);
    assert.strictEqual(resolved[1]?.isDefault, true);
    assert.strictEqual(resolved[1]?.isLegacy, undefined);
    assert.deepStrictEqual(resolved[1]?.capabilities?.optionDescriptors?.[0], {
      id: "reasoningEffort",
      label: "Reasoning effort",
      type: "select",
      currentValue: "native-low",
      options: [
        { id: "native-high", label: "High", isDefault: false },
        { id: "native-low", label: "Low", isDefault: true },
      ],
    });
  });

  it("keeps a legacy group current while one of its native aliases is current", () => {
    const resolved = applyAntigravityModelCatalog(
      draft([model({ slug: "group", aliases: ["native-old", "native-new"] })]),
      {
        models: [
          {
            slug: "group",
            name: "Group",
            status: "legacy",
            capabilities: null,
            adapter: undefined,
            profileAdapter: undefined,
          },
          {
            slug: "native-old",
            name: "Old",
            status: "legacy",
            capabilities: null,
            adapter: undefined,
            profileAdapter: undefined,
          },
        ],
        defaultChatModel: undefined,
      },
    ).models;
    assert.strictEqual(resolved[0]?.isLegacy, undefined);
  });
});
