import type { ProjectIconColor, ProjectIconOverride } from "@t3tools/contracts";

import { deriveProjectIdentity } from "./projectIdentity";

export type ProjectIconSource =
  | { readonly kind: "image"; readonly dataUrl: string }
  | { readonly kind: "monogram"; readonly text: string; readonly color: ProjectIconColor }
  | { readonly kind: "emoji"; readonly emoji: string };

/**
 * What a notification shows for its project, as the sidebar picks it: an override, else the
 * cached favicon, else the initials tile. Only a cached data URL counts, so nothing is fetched.
 * A lucide override has no bitmap yet and shows the initials tile.
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
  if (icon?.kind !== "lucide" && cachedFavicon?.startsWith("data:image/")) {
    return { kind: "image", dataUrl: cachedFavicon };
  }
  const identity = deriveProjectIdentity(project.title);
  return { kind: "monogram", text: identity.monogram, color: identity.color };
}

/**
 * One drawn icon per project, redrawn only when its source or the appearance changes. `get` never
 * waits: a notification without a drawn icon is shown without one.
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
    if (current?.key === key) return current.drawn;
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
    entries.set(projectKey, entry);
    return entry.drawn;
  };
  return {
    warm,
    get: (projectKey: string, source: ProjectIconSource, dark: boolean): string | null => {
      void warm(projectKey, source, dark);
      return entries.get(projectKey)?.icon ?? null;
    },
  };
}
