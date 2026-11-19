import type { ComponentType } from "react";

import type { SettingsForkFeature } from "../settings/forkFeatures";

export interface ExplainerSlide {
  readonly title: string;
  readonly lines: readonly [string, string];
  /** How many frames the scene has; the last one is where the slide rests. */
  readonly steps: number;
  readonly Scene: ComponentType<{ readonly step: number }>;
}

export interface FeatureExplainer {
  /** The fork ledger id of the feature it shows, so retiring the feature flags its explainer. */
  readonly feature: SettingsForkFeature;
  readonly title: string;
  readonly guideUrl: string;
  readonly slides: readonly ExplainerSlide[];
}

export const FEATURE_EXPLAINERS_SEEN_STORAGE_KEY = "styal:feature-explainers-seen:v1";

/** How long each scene step stays before the next one draws. */
export const EXPLAINER_STEP_MS = 1100;

/**
 * Decides whether an explainer opens and what this device then remembers. Turning the
 * feature on opens it only the first time; the link always opens it. Either way it
 * counts as seen, so it never opens by itself again.
 */
export function explainerOpening(
  seen: readonly string[],
  feature: string,
  trigger: "enabled" | "link",
): { readonly open: boolean; readonly seen: readonly string[] } {
  const known = seen.includes(feature);
  return {
    open: trigger === "link" || !known,
    seen: known ? seen : [...seen, feature],
  };
}

/** Reduced motion skips playback and shows the frame the slide rests on. */
export function firstSceneStep(steps: number, reducedMotion: boolean): number {
  return reducedMotion ? steps - 1 : 0;
}

/** The step to draw next, or null once the scene has reached its last frame. */
export function nextSceneStep(step: number, steps: number): number | null {
  return step + 1 < steps ? step + 1 : null;
}
