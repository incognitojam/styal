import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";

/** Last desktop app version this window's user was shown, or silently recorded on first run. */
export const DESKTOP_LAST_SEEN_VERSION_STORAGE_KEY = "styal:desktop-last-seen-version:v1";

export interface DesktopUpdatedNoticeDecision {
  /** The version to announce, when the app now runs a newer build than last seen. */
  readonly announce: string | null;
  /** Whether the current version should be stored as the last seen version. */
  readonly record: boolean;
}

/**
 * Announce only a move to a newer version. A first run (nothing stored), a
 * downgrade or channel switch to a lower version, and versions that do not
 * parse are recorded without a notice, so the next real update compares
 * against the version the user actually ran.
 */
export function decideDesktopUpdatedNotice(
  lastSeenVersion: string | null,
  currentVersion: string,
): DesktopUpdatedNoticeDecision {
  const current = currentVersion.trim();
  if (current.length === 0) return { announce: null, record: false };
  const lastSeen = lastSeenVersion?.trim() ?? "";
  if (lastSeen === current) return { announce: null, record: false };
  if (
    lastSeen.length > 0 &&
    parseSemver(lastSeen) !== null &&
    parseSemver(current) !== null &&
    compareSemverVersions(current, lastSeen) > 0
  ) {
    return { announce: current, record: true };
  }
  return { announce: null, record: true };
}

/** Whether the user can currently see the window, and changes to that. */
export interface WindowAttention {
  readonly isAttended: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
}

/** A window counts as looked at when its document is visible and focused. */
export function documentWindowAttention(): WindowAttention {
  return {
    isAttended: () => document.visibilityState === "visible" && document.hasFocus(),
    subscribe: (listener) => {
      document.addEventListener("visibilitychange", listener);
      window.addEventListener("focus", listener);
      return () => {
        document.removeEventListener("visibilitychange", listener);
        window.removeEventListener("focus", listener);
      };
    },
  };
}

export interface LastSeenVersionStore {
  readonly read: () => string | null;
  readonly write: (version: string) => void;
}

/**
 * Shows the updated notice once per version, waiting until the window is
 * looked at. The version is stored when the notice shows, so a window that
 * stays hidden until quit still announces the update on the next launch.
 * Returns a cleanup that stops waiting.
 */
export function startDesktopUpdatedNotice(input: {
  readonly currentVersion: string;
  readonly store: LastSeenVersionStore;
  readonly attention: WindowAttention;
  readonly show: (version: string) => void;
}): () => void {
  const decision = decideDesktopUpdatedNotice(input.store.read(), input.currentVersion);
  const version = decision.announce;
  if (version === null) {
    if (decision.record) input.store.write(input.currentVersion.trim());
    return () => {};
  }

  let done = false;
  let unsubscribe = () => {};
  const showWhenAttended = () => {
    if (done || !input.attention.isAttended()) return;
    done = true;
    unsubscribe();
    // Another window or an earlier mount may have shown it already.
    if (decideDesktopUpdatedNotice(input.store.read(), version).announce === null) return;
    input.store.write(version);
    input.show(version);
  };
  unsubscribe = input.attention.subscribe(showWhenAttended);
  showWhenAttended();
  return () => {
    done = true;
    unsubscribe();
  };
}
