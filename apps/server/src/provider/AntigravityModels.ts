import { ANTIGRAVITY_DEFAULT_MODEL, type ServerProviderModel } from "@t3tools/contracts";

/** ACP names identify thinking variants; IDs need not share a suffix (e.g. gemini-pro-agent). */
export function groupAntigravityModels(
  entries: ReadonlyArray<{ readonly value: string; readonly name: string }>,
  currentModel: string | undefined,
): ReadonlyArray<ServerProviderModel> {
  const models = new Map<string, ServerProviderModel>();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.value.trim() || seen.has(entry.value)) continue;
    seen.add(entry.value);
    const variant = /^(Gemini \d+(?:\.\d+)* [\w -]+) \((Minimal|Low|Medium|High)\)$/.exec(
      entry.name.trim(),
    );
    const name = variant?.[1] ?? (entry.name.trim() || entry.value);
    const slug = variant ? name.toLowerCase().replaceAll(" ", "-") : entry.value;
    const previous = models.get(slug);
    const isDefault = previous?.isDefault || entry.value === currentModel;
    const aliases = [
      ...(previous?.aliases ?? []).filter((alias) => alias !== ANTIGRAVITY_DEFAULT_MODEL),
      entry.value,
    ];
    const choices = previous?.capabilities?.optionDescriptors?.[0];
    const options = [
      ...(choices?.type === "select" ? choices.options : []),
      { id: entry.value, label: variant?.[2] ?? name },
    ];
    // A cold resume must not make another thread's current effort our default.
    const defaultChoice = options.find((option) => option.label === "High") ?? options[0]!;
    models.set(slug, {
      slug,
      name,
      isCustom: false,
      ...(isDefault ? { isDefault: true } : {}),
      aliases: [...aliases, ...(isDefault ? [ANTIGRAVITY_DEFAULT_MODEL] : [])],
      capabilities: {
        optionDescriptors: variant
          ? [
              {
                id: "reasoningEffort",
                label: "Reasoning effort",
                type: "select",
                currentValue: defaultChoice.id,
                options: options.map((option) => ({
                  ...option,
                  isDefault: option.id === defaultChoice.id,
                })),
              },
            ]
          : [],
      },
    });
  }
  return [...models.values()];
}
