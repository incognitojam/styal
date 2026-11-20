import type { ProjectIconColor, ProjectIconOverride } from "@t3tools/contracts";

import { deriveProjectIdentity } from "./projectIdentity";

type MonogramSource = {
  readonly kind: "monogram";
  readonly text: string;
  readonly color: ProjectIconColor;
};

export type ProjectIconSource =
  /** `fallback` is drawn instead when the image cannot be decoded. */
  | { readonly kind: "image"; readonly dataUrl: string; readonly fallback: MonogramSource }
  | MonogramSource
  | Extract<ProjectIconOverride, { kind: "lucide" }>
  | { readonly kind: "emoji"; readonly emoji: string };

/**
 * What a notification shows for its project, as the sidebar picks it: an override, else the
 * cached favicon, else the initials tile. Only a cached data URL counts, so nothing is fetched.
 */
export function projectIconSource(
  project: {
    readonly title: string;
    readonly projectIcon?: ProjectIconOverride | null | undefined;
  },
  cachedFavicon: string | null,
): ProjectIconSource {
  const icon = project.projectIcon;
  if (icon?.kind === "monogram") return { kind: "monogram", text: icon.text, color: icon.color };
  if (icon?.kind === "emoji") return { kind: "emoji", emoji: icon.emoji };
  if (icon?.kind === "lucide") return icon;
  const identity = deriveProjectIdentity(project.title);
  const tile: MonogramSource = { kind: "monogram", text: identity.monogram, color: identity.color };
  return cachedFavicon?.startsWith("data:image/")
    ? { kind: "image", dataUrl: cachedFavicon, fallback: tile }
    : tile;
}

const MAX_CACHED_PROJECTS = 64;

/**
 * One drawn icon per project, redrawn only when its source or the appearance changes, for the
 * projects that notified most recently. `get` only looks up: a notification whose icon is not
 * drawn yet is shown without one.
 */
export function createProjectIconCache(
  draw: (source: ProjectIconSource, dark: boolean) => Promise<string>,
) {
  const entries = new Map<
    string,
    { readonly key: string; icon: string | null; readonly drawn: Promise<void> }
  >();
  const warm = (projectKey: string, source: ProjectIconSource, dark: boolean): Promise<void> => {
    const key = JSON.stringify([source, dark]);
    const current = entries.get(projectKey);
    if (current?.key === key) {
      entries.delete(projectKey);
      entries.set(projectKey, current);
      return current.drawn;
    }
    const entry: { readonly key: string; icon: string | null; drawn: Promise<void> } = {
      key,
      icon: null,
      drawn: Promise.resolve(),
    };
    entry.drawn = draw(source, dark).then(
      (icon) => {
        entry.icon = icon;
      },
      () => {},
    );
    entries.delete(projectKey);
    entries.set(projectKey, entry);
    if (entries.size > MAX_CACHED_PROJECTS) entries.delete(entries.keys().next().value!);
    return entry.drawn;
  };
  return {
    warm,
    get: (projectKey: string, source: ProjectIconSource, dark: boolean): string | null => {
      const entry = entries.get(projectKey);
      return entry?.key === JSON.stringify([source, dark]) ? entry.icon : null;
    },
  };
}
