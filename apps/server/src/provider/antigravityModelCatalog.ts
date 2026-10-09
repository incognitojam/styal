/**
 * Antigravity's view of its manifest catalog. Antigravity reports one model per
 * reasoning level and aliases them to the level the user picks, so its
 * catalog default and legacy flags follow those aliases.
 *
 * @module provider/antigravityModelCatalog
 */
import { ANTIGRAVITY_DEFAULT_MODEL, type ServerProviderModel } from "@t3tools/contracts";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";

const isLegacySlug = (catalog: ModelCatalog.ProviderCatalog | undefined, slug: string) =>
  catalog?.models.find((entry) => entry.slug === slug)?.status === "legacy";

/**
 * A legacy model stays current while one of its aliases, other than the
 * provider default alias, names a current model.
 */
function classifyAntigravityModels(
  models: ReadonlyArray<ServerProviderModel>,
  catalog: ModelCatalog.ProviderCatalog | undefined,
): ReadonlyArray<ServerProviderModel> {
  const classified = ModelCatalog.classifyCatalogModels(models, catalog);
  return classified.map((model) => {
    if (!model.isLegacy) return model;
    const current = model.aliases?.some(
      (alias) => alias !== ANTIGRAVITY_DEFAULT_MODEL && !isLegacySlug(catalog, alias),
    );
    if (!current) return model;
    const { isLegacy: _isLegacy, ...rest } = model;
    return rest;
  });
}

/**
 * Moves the default to the catalog's chat default, matching it by slug or alias,
 * even when no model is the default yet. The provider default alias moves with it,
 * and the model's reasoning effort selection starts at the default level.
 */
function applyAntigravityDefault(
  models: ReadonlyArray<ServerProviderModel>,
  catalog: ModelCatalog.ProviderCatalog | undefined,
): ReadonlyArray<ServerProviderModel> {
  const requestedSlug = catalog?.defaultChatModel;
  if (requestedSlug === undefined) return models;
  const slug = models.find(
    (model) => model.slug === requestedSlug || model.aliases?.includes(requestedSlug),
  )?.slug;
  if (slug === undefined) return models;
  const previous = models.find((model) => model.isDefault && model.slug !== slug);
  return models.map((model) => {
    if (model.slug === previous?.slug) {
      const { isDefault: _isDefault, aliases: previousAliases, ...rest } = model;
      const aliases = previousAliases?.filter((alias) => alias !== ANTIGRAVITY_DEFAULT_MODEL);
      return { ...rest, ...(aliases?.length ? { aliases } : {}) };
    }
    if (model.slug !== slug) return model;
    const aliases = [...new Set([...(model.aliases ?? []), ANTIGRAVITY_DEFAULT_MODEL])];
    const capabilities = model.capabilities
      ? {
          ...model.capabilities,
          optionDescriptors: model.capabilities.optionDescriptors?.map((descriptor) => {
            if (
              descriptor.type !== "select" ||
              descriptor.id !== "reasoningEffort" ||
              !descriptor.options.some((option) => option.id === requestedSlug)
            )
              return descriptor;
            return {
              ...descriptor,
              currentValue: requestedSlug,
              options: descriptor.options.map((option) => ({
                ...option,
                isDefault: option.id === requestedSlug,
              })),
            };
          }),
        }
      : model.capabilities;
    return { ...model, capabilities, isDefault: true, aliases };
  });
}

/** Reclassifies an Antigravity snapshot draft's models against its catalog. */
export function applyAntigravityModelCatalog(
  draft: ServerProviderDraft,
  catalog: ModelCatalog.ProviderCatalog | undefined,
): ServerProviderDraft {
  const { updateRequiredModels: _previous, ...rest } = draft;
  return {
    ...rest,
    models: applyAntigravityDefault(classifyAntigravityModels(draft.models, catalog), catalog),
  };
}
