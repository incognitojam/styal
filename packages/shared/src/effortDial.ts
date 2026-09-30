/**
 * The effort dial: four levels that each resolve to a provider, model and
 * reasoning effort, so users pick how hard to work rather than raw effort
 * levels. Only Codex and Claude take part; other providers keep their own
 * effort controls.
 */

export const EFFORT_DIAL_LEVELS = ["light", "standard", "deep", "ultra"] as const;
export type EffortDialLevel = (typeof EFFORT_DIAL_LEVELS)[number];

export const EFFORT_DIAL_LEVEL_LABELS: Readonly<Record<EffortDialLevel, string>> = {
  light: "Light",
  standard: "Standard",
  deep: "Deep",
  ultra: "Ultra",
};

export type EffortDialDriver = "codex" | "claudeAgent";

export function isEffortDialDriver(driver: string): driver is EffortDialDriver {
  return driver === "codex" || driver === "claudeAgent";
}

interface EffortDialCandidate {
  readonly driver: EffortDialDriver;
  readonly model: string;
  readonly effort: string;
}

const codex = (model: string, effort: string): EffortDialCandidate => ({
  driver: "codex",
  model,
  effort,
});
const claude = (model: string, effort: string): EffortDialCandidate => ({
  driver: "claudeAgent",
  model,
  effort,
});

/**
 * Candidates per provider, first available wins. Used when a thread is locked
 * to that provider or it is the only one configured. Later entries cover CLIs
 * that do not offer the newest model yet.
 */
const PROVIDER_COLUMNS: Readonly<
  Record<EffortDialDriver, Readonly<Record<EffortDialLevel, ReadonlyArray<EffortDialCandidate>>>>
> = {
  codex: {
    light: [codex("gpt-6.1-sol", "low"), codex("gpt-6-sol", "medium")],
    standard: [codex("gpt-6.1-sol", "medium"), codex("gpt-6-sol", "high")],
    deep: [codex("gpt-6.1-sol", "xhigh"), codex("gpt-6-astra", "high")],
    ultra: [codex("gpt-6-astra", "xhigh")],
  },
  claudeAgent: {
    light: [claude("claude-sonnet-5-5", "high")],
    standard: [claude("claude-opus-5-5", "medium")],
    deep: [claude("claude-opus-5-5", "high")],
    ultra: [claude("claude-fable-5-1", "high"), claude("claude-opus-5-5", "high")],
  },
};

/** Candidates for a new thread when both providers are available. */
const CROSS_PROVIDER: Readonly<Record<EffortDialLevel, ReadonlyArray<EffortDialCandidate>>> = {
  light: [
    codex("gpt-6.1-sol", "medium"),
    codex("gpt-6-sol", "high"),
    claude("claude-sonnet-5-5", "high"),
  ],
  standard: [claude("claude-opus-5-5", "medium"), codex("gpt-6.1-sol", "medium")],
  deep: [claude("claude-opus-5-5", "high"), codex("gpt-6.1-sol", "xhigh")],
  ultra: [
    claude("claude-fable-5-1", "high"),
    claude("claude-opus-5-5", "high"),
    codex("gpt-6-astra", "xhigh"),
  ],
};

/** Effort a level maps to on a model the tables do not cover. */
const GENERIC_EFFORT: Readonly<Record<EffortDialLevel, string>> = {
  light: "low",
  standard: "medium",
  deep: "high",
  ultra: "xhigh",
};

const EFFORT_SCALE = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** A model the dial can choose, with the reasoning efforts it offers. */
export interface EffortDialModel {
  readonly instanceId: string;
  readonly driver: EffortDialDriver;
  readonly model: string;
  readonly efforts: ReadonlyArray<string>;
}

export interface EffortDialTarget {
  readonly instanceId: string;
  readonly driver: EffortDialDriver;
  readonly model: string;
  readonly effort: string;
}

export interface EffortDialContext {
  /** Models on enabled, available instances, in instance display order. */
  readonly models: ReadonlyArray<EffortDialModel>;
  /** The provider a started thread is locked to, if any. */
  readonly lockedDriver: EffortDialDriver | null;
  /** The composer's current selection, used to keep its instance and models picked by hand. */
  readonly current: { readonly instanceId: string; readonly model: string } | null;
}

/** The supported effort nearest to `wanted`, preferring lower efforts over higher ones. */
function nearestEffort(efforts: ReadonlyArray<string>, wanted: string): string | null {
  if (efforts.includes(wanted)) return wanted;
  const scaled = EFFORT_SCALE.filter((effort) => efforts.includes(effort));
  const wantedIndex = EFFORT_SCALE.indexOf(wanted as (typeof EFFORT_SCALE)[number]);
  const below = scaled.filter((effort) => EFFORT_SCALE.indexOf(effort) < wantedIndex);
  return below.at(-1) ?? scaled[0] ?? null;
}

function findModel(
  context: EffortDialContext,
  driver: EffortDialDriver,
  model: string,
): EffortDialModel | undefined {
  const matches = context.models.filter(
    (candidate) => candidate.driver === driver && candidate.model === model,
  );
  return (
    matches.find((candidate) => candidate.instanceId === context.current?.instanceId) ?? matches[0]
  );
}

function isTableModel(driver: EffortDialDriver, model: string): boolean {
  return EFFORT_DIAL_LEVELS.some((level) =>
    PROVIDER_COLUMNS[driver][level].some((candidate) => candidate.model === model),
  );
}

/**
 * What choosing `level` selects. A model picked by hand that the tables do not
 * cover keeps its model and only changes effort. Returns null when nothing
 * available fits the level.
 */
export function resolveEffortDialLevel(
  level: EffortDialLevel,
  context: EffortDialContext,
): EffortDialTarget | null {
  const currentModel = context.current
    ? context.models.find(
        (candidate) =>
          candidate.instanceId === context.current?.instanceId &&
          candidate.model === context.current.model,
      )
    : undefined;
  if (currentModel && !isTableModel(currentModel.driver, currentModel.model)) {
    const effort = nearestEffort(currentModel.efforts, GENERIC_EFFORT[level]);
    return effort ? { ...currentModel, effort } : null;
  }

  const drivers = new Set(context.models.map((candidate) => candidate.driver));
  const candidates =
    context.lockedDriver !== null
      ? PROVIDER_COLUMNS[context.lockedDriver][level]
      : drivers.size > 1
        ? CROSS_PROVIDER[level]
        : drivers.has("codex")
          ? PROVIDER_COLUMNS.codex[level]
          : drivers.has("claudeAgent")
            ? PROVIDER_COLUMNS.claudeAgent[level]
            : [];
  for (const candidate of candidates) {
    const model = findModel(context, candidate.driver, candidate.model);
    if (model?.efforts.includes(candidate.effort)) {
      return {
        instanceId: model.instanceId,
        driver: model.driver,
        model: model.model,
        effort: candidate.effort,
      };
    }
  }
  return null;
}

/** The level whose target is exactly the current selection, or null for anything else. */
export function currentEffortDialLevel(
  selection: {
    readonly instanceId: string;
    readonly model: string;
    readonly effort: string | null;
  },
  context: EffortDialContext,
): EffortDialLevel | null {
  return (
    EFFORT_DIAL_LEVELS.find((level) => {
      const target = resolveEffortDialLevel(level, context);
      return (
        target !== null &&
        target.instanceId === selection.instanceId &&
        target.model === selection.model &&
        target.effort === selection.effort
      );
    }) ?? null
  );
}
