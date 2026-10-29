import { startSettingsSnapshotReports } from "@t3tools/client-runtime/settings-snapshot";
import { useEffect } from "react";

import {
  CLIENT_SETTINGS_SNAPSHOT_STORAGE_KEY,
  clientSettingsSnapshot,
} from "../clientSettingsSnapshot";
import { reportForkClientUsage } from "../forkClientUsage";
import { useForkUsageEnvironmentId } from "../forkUsageEnvironment";
import { getClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import { useUiStateStore } from "../uiStateStore";

/**
 * Reports this device's preferences at most once a day through one server, so
 * client defaults can be judged the way `settings.snapshot` judges server ones.
 * Windows share the day through local storage.
 */
export function ClientSettingsSnapshotReporter() {
  const hydrated = useClientSettingsHydrated();
  const environmentId = useForkUsageEnvironmentId();

  useEffect(() => {
    if (!hydrated || !environmentId) return;
    return startSettingsSnapshotReports({
      readLastReportedAt: () => localStorage.getItem(CLIENT_SETTINGS_SNAPSHOT_STORAGE_KEY),
      saveReportedAt: (reportedAt) =>
        localStorage.setItem(CLIENT_SETTINGS_SNAPSHOT_STORAGE_KEY, reportedAt),
      report: () =>
        reportForkClientUsage(
          environmentId,
          clientSettingsSnapshot(getClientSettings(), useUiStateStore.getState()),
        ),
    });
  }, [environmentId, hydrated]);

  return null;
}
