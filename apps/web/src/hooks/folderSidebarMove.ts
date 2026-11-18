import type { ClientSettings, ClientSettingsPatch } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "./useLocalStorage";

// Kept apart from the client settings, which older builds rewrite without fields they do not know.
export const FOLDER_SIDEBAR_MOVED_KEY = "styal:folder-sidebar-moved:v1";

/**
 * Moves this device to project folders once. A stored flat list cannot be told
 * from an untouched default, so every device moves; later choices stay. Grouped
 * headers kept a saved project order, which folders follow only under Manual.
 */
export function takeFolderSidebarMove(
  settings: ClientSettings,
  savedProjectOrder: readonly string[],
): ClientSettingsPatch | null {
  try {
    if (getLocalStorageItem(FOLDER_SIDEBAR_MOVED_KEY, Schema.Boolean)) return null;
    setLocalStorageItem(FOLDER_SIDEBAR_MOVED_KEY, true, Schema.Boolean);
  } catch {
    return null;
  }
  const keepsGroupedOrder =
    !settings.boringSidebarEnabled &&
    settings.sidebarThreadGrouping === "project" &&
    savedProjectOrder.length > 0;
  return {
    boringSidebarEnabled: true,
    ...(keepsGroupedOrder ? { sidebarProjectSortOrder: "manual" } : {}),
  };
}
