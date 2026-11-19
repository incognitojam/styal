import * as Schema from "effect/Schema";
import { useEffect } from "react";

import {
  DESKTOP_LAST_SEEN_VERSION_STORAGE_KEY,
  documentWindowAttention,
  startDesktopUpdatedNotice,
  type LastSeenVersionStore,
} from "../desktopUpdatedNotice";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import { getDesktopUpdateReleaseUrl } from "./desktopUpdate.logic";
import { openDesktopUpdateReleaseNotes } from "./desktopUpdate.toast";
import { toastManager } from "./ui/toast";

const NOTICE_VISIBLE_MS = 10_000;

const lastSeenVersionStore: LastSeenVersionStore = {
  read: () => {
    try {
      return getLocalStorageItem(DESKTOP_LAST_SEEN_VERSION_STORAGE_KEY, Schema.String);
    } catch {
      return null;
    }
  },
  write: (version) => {
    try {
      setLocalStorageItem(DESKTOP_LAST_SEEN_VERSION_STORAGE_KEY, version, Schema.String);
    } catch {
      // An unavailable store only means the next update is not announced.
    }
  },
};

function showDesktopUpdatedToast(version: string) {
  const releaseUrl = getDesktopUpdateReleaseUrl(version);
  const toastId = toastManager.add({
    type: "success",
    title: `Updated to v${version}`,
    timeout: 0,
    ...(releaseUrl
      ? {
          actionProps: {
            children: "Release notes",
            onClick: () => {
              toastManager.close(toastId);

              void openDesktopUpdateReleaseNotes(window.desktopBridge, releaseUrl);
            },
          },
        }
      : {}),
    data: { hideCopyButton: true, dismissAfterVisibleMs: NOTICE_VISIBLE_MS },
  });
}

/** Desktop only: announces the version the app updated to, once, when the window is looked at. */
export function DesktopUpdatedNotice() {
  const currentVersion = useDesktopUpdateState()?.currentVersion ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the desktop update notice using persisted version storage and window attention listeners
  useEffect(() => {
    if (import.meta.env.DEV || !currentVersion) return;
    return startDesktopUpdatedNotice({
      currentVersion,
      store: lastSeenVersionStore,
      attention: documentWindowAttention(),
      show: (version) => {
        showDesktopUpdatedToast(version);
      },
    });
  }, [currentVersion]);

  return null;
}
