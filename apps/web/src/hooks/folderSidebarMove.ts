import type { ClientSettings, ClientSettingsPatch } from "@t3tools/contracts";

/**
 * Moves this device to project folders once. A stored flat list cannot be told
 * from an untouched default, so every device moves; later choices stay. Grouped
 * headers kept a saved project order, which folders follow only under Manual.
 */
export function folderSidebarMovePatch(
  settings: ClientSettings,
  savedProjectOrder: readonly string[],
): ClientSettingsPatch | null {
  if (settings.folderSidebarDefaultApplied) return null;
  const keepsGroupedOrder =
    !settings.boringSidebarEnabled &&
    settings.sidebarThreadGrouping === "project" &&
    savedProjectOrder.length > 0;
  return {
    boringSidebarEnabled: true,
    folderSidebarDefaultApplied: true,
    ...(keepsGroupedOrder ? { sidebarProjectSortOrder: "manual" } : {}),
  };
}
