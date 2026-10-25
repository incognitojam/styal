import type { DesktopUpdateActionResult } from "@t3tools/contracts";

import { getDesktopUpdateActionError } from "./components/desktopUpdate.logic";
import { isElectron } from "./env";

export const DESKTOP_UPDATE_RETURN_ROUTE_STORAGE_KEY = "styal:desktop-update-return-route:v1";
const RETURN_ROUTE_MAX_AGE_MS = 10 * 60_000;

function isReturnRoute(hash: unknown): hash is string {
  return (
    typeof hash === "string" && hash.startsWith("#/") && !hash.startsWith("#//") && hash !== "#/"
  );
}

function clearReturnRoute(): void {
  try {
    window.localStorage.removeItem(DESKTOP_UPDATE_RETURN_ROUTE_STORAGE_KEY);
  } catch {}
}

export async function installDesktopUpdate(
  install: () => Promise<DesktopUpdateActionResult>,
): Promise<DesktopUpdateActionResult> {
  if (!isElectron) return install();

  clearReturnRoute();
  try {
    const hash = window.location.hash;
    if (isReturnRoute(hash)) {
      // localStorage survives the new Electron window created by the installer.
      window.localStorage.setItem(
        DESKTOP_UPDATE_RETURN_ROUTE_STORAGE_KEY,
        JSON.stringify({ hash, savedAt: Date.now() }),
      );
    }
  } catch {}

  try {
    const result = await install();
    if (
      !result.accepted ||
      result.state.status === "error" ||
      getDesktopUpdateActionError(result) !== null
    ) {
      clearReturnRoute();
    }
    return result;
  } catch (error) {
    clearReturnRoute();
    throw error;
  }
}

export function restoreDesktopUpdateReturnRoute(): void {
  if (!isElectron) return;

  try {
    const storage = window.localStorage;
    const raw = storage.getItem(DESKTOP_UPDATE_RETURN_ROUTE_STORAGE_KEY);
    storage.removeItem(DESKTOP_UPDATE_RETURN_ROUTE_STORAGE_KEY);
    if (raw === null) return;

    // Explicit launch routes win, and the handoff must never affect a later launch.
    if (window.location.hash !== "" && window.location.hash !== "#/") return;
    const handoff: unknown = JSON.parse(raw);
    if (
      typeof handoff !== "object" ||
      handoff === null ||
      !("hash" in handoff) ||
      !isReturnRoute(handoff.hash) ||
      !("savedAt" in handoff) ||
      typeof handoff.savedAt !== "number" ||
      !Number.isFinite(handoff.savedAt)
    ) {
      return;
    }
    const age = Date.now() - handoff.savedAt;
    if (age < 0 || age >= RETURN_ROUTE_MAX_AGE_MS) return;

    window.history.replaceState(window.history.state, "", handoff.hash);
  } catch {}
}
