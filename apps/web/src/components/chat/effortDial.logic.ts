import type {
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  isEffortDialDriver,
  type EffortDialDriver,
  type EffortDialModel,
} from "@t3tools/shared/effortDial";
import { getProviderOptionDescriptors } from "@t3tools/shared/model";

import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";

/** The option each dial provider stores its reasoning effort under. */
export const EFFORT_DIAL_OPTION_ID: Readonly<Record<EffortDialDriver, string>> = {
  claudeAgent: "effort",
  codex: "reasoningEffort",
};

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

export function findEffortDescriptor(
  driver: EffortDialDriver,
  model: ServerProviderModel | undefined,
): SelectDescriptor | undefined {
  return model?.capabilities?.optionDescriptors?.find(
    (descriptor): descriptor is SelectDescriptor =>
      descriptor.type === "select" && descriptor.id === EFFORT_DIAL_OPTION_ID[driver],
  );
}

/** Models the dial can choose from: every model with an effort option on a ready Codex or Claude instance. */
export function buildEffortDialModels(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<EffortDialModel> {
  const models: EffortDialModel[] = [];
  for (const entry of entries) {
    const driver = entry.driverKind;
    if (!isEffortDialDriver(driver) || !isProviderInstancePickerReady(entry)) continue;
    for (const model of entry.models) {
      const descriptor = findEffortDescriptor(driver, model);
      if (!descriptor) continue;
      // Prompt-injected levels (ultrathink) are typed into the prompt, not chosen here.
      const injected = new Set(descriptor.promptInjectedValues ?? []);
      models.push({
        instanceId: entry.instanceId,
        driver,
        model: model.slug,
        efforts: descriptor.options.map((option) => option.id).filter((id) => !injected.has(id)),
      });
    }
  }
  return models;
}

export interface EffortDialModelChoice {
  readonly entry: ProviderInstanceEntry;
  readonly model: ServerProviderModel;
}

/**
 * Models offered in place of the levels: current, built-in models with an
 * effort option on ready Codex and Claude instances, limited to the locked
 * provider in a started thread. Legacy and custom models stay in the full list.
 */
export function buildEffortDialModelChoices(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  lockedDriver: EffortDialDriver | null,
): ReadonlyArray<EffortDialModelChoice> {
  const choices: EffortDialModelChoice[] = [];
  for (const entry of entries) {
    const driver = entry.driverKind;
    if (!isEffortDialDriver(driver) || !isProviderInstancePickerReady(entry)) continue;
    if (lockedDriver !== null && driver !== lockedDriver) continue;
    for (const model of entry.models) {
      if (model.isCustom || model.isLegacy || !findEffortDescriptor(driver, model)) continue;
      choices.push({ entry, model });
    }
  }
  return choices;
}

/** `options` with `id` set to `value`, keeping every other option. */
export function withProviderOption(
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
  id: string,
  value: string | boolean,
): ReadonlyArray<ProviderOptionSelection> {
  return [...(options ?? []).filter((option) => option.id !== id), { id, value }];
}

// "Standard" is also a dial level, so the usual speed is called Normal here.
const NORMAL_SPEED_LABEL = "Normal";

export interface EffortDialSpeedControl {
  readonly id: string;
  readonly choices: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
    /** What the choice costs or does, from the provider. */
    readonly description?: string;
  }>;
  readonly value: string;
  /** Converts a choice back to the option value it stores. */
  readonly toOptionValue: (choice: string) => string | boolean;
}

/** The speed control for a model: Claude's fast mode or Codex's service tier, when offered. */
export function getEffortDialSpeedControl(
  model: ServerProviderModel | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | undefined,
): EffortDialSpeedControl | null {
  if (!model?.capabilities) return null;
  const descriptors = getProviderOptionDescriptors({ caps: model.capabilities, selections });
  const fastMode = descriptors.find((descriptor) => descriptor.id === "fastMode");
  if (fastMode?.type === "boolean") {
    return {
      id: "fastMode",
      choices: [
        { value: "standard", label: NORMAL_SPEED_LABEL },
        {
          value: "fast",
          label: "Fast",
          ...(fastMode.description ? { description: fastMode.description } : {}),
        },
      ],
      value: fastMode.currentValue === true ? "fast" : "standard",
      toOptionValue: (choice) => choice === "fast",
    };
  }
  const serviceTier = descriptors.find((descriptor) => descriptor.id === "serviceTier");
  if (serviceTier?.type === "select" && serviceTier.options.length > 1) {
    return {
      id: "serviceTier",
      choices: serviceTier.options.map((option) => ({
        value: option.id,
        label: option.id === "default" ? NORMAL_SPEED_LABEL : option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
      value:
        serviceTier.currentValue ??
        serviceTier.options.find((option) => option.isDefault)?.id ??
        serviceTier.options[0]!.id,
      toOptionValue: (choice) => choice,
    };
  }
  return null;
}
