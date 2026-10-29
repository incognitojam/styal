import * as Updates from "expo-updates";

import { loadPreferences, type Preferences, updatePreferences } from "../../persistence/imperative";

// The workspace page, without sheets or overlays.
let currentWorkspacePath: string | null = null;

export function setCurrentWorkspacePath(path: string): void {
  currentWorkspacePath = path;
}

/**
 * An update restart reloads JS from scratch, and the navigator would start on
 * Home. Records where the user was so the next launch can open it instead.
 */
export async function saveUpdateRestartLocation(): Promise<void> {
  const path = currentWorkspacePath;
  if (path === null || path === "/") return;
  await updatePreferences(() => ({
    updateRestartLocation: { path, fromUpdateId: Updates.updateId },
  }));
}

/**
 * Only a launch running a different update than the one that saved the
 * location counts as that restart: if `reloadAsync` failed, the location is
 * stale by the next ordinary launch.
 */
function restorableUpdateRestartPath(
  saved: Preferences["updateRestartLocation"],
  runningUpdateId: string | null,
): string | null {
  if (saved === undefined || saved.fromUpdateId === runningUpdateId) return null;
  return saved.path;
}

/** Reads the saved location once; it is cleared whether or not it applies. */
export async function takeUpdateRestartPath(): Promise<string | null> {
  const saved = (await loadPreferences()).updateRestartLocation;
  if (saved === undefined) return null;
  await updatePreferences(() => ({ updateRestartLocation: undefined }));
  return restorableUpdateRestartPath(saved, Updates.updateId);
}
