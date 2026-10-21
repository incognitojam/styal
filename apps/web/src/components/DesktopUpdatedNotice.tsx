import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";

import {
  DESKTOP_LAST_SEEN_VERSION_STORAGE_KEY,
  documentWindowAttention,
  startDesktopUpdatedNotice,
  type LastSeenVersionStore,
} from "../desktopUpdatedNotice";
import { reportForkClientUsage, supportsForkClientUsage } from "../forkClientUsage";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { primaryServerConfigAtom } from "../state/server";
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
              void reportForkClientUsage(appAtomRegistry.get(primaryEnvironmentIdAtom), {
                feature: "desktop-update-notice",
                action: "release_notes_opened",
              });
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
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const supported = supportsForkClientUsage(useAtomValue(primaryServerConfigAtom));
  const [shown, setShown] = useState(false);
  const exposureReported = useRef(false);

  useEffect(() => {
    if (!currentVersion) return;
    return startDesktopUpdatedNotice({
      currentVersion,
      store: lastSeenVersionStore,
      attention: documentWindowAttention(),
      show: (version) => {
        showDesktopUpdatedToast(version);
        setShown(true);
      },
    });
  }, [currentVersion]);

  // The notice can show before the local server connects; report it once support is known.
  useEffect(() => {
    if (!shown || !environmentId || !supported || exposureReported.current) return;
    exposureReported.current = true;
    void reportForkClientUsage(environmentId, {
      feature: "desktop-update-notice",
      action: "notice_shown",
    });
  }, [environmentId, shown, supported]);

  return null;
}
