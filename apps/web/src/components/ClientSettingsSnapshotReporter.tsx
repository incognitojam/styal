import { useEffect } from "react";

import {
  CLIENT_SETTINGS_SNAPSHOT_STORAGE_KEY,
  clientSettingsSnapshot,
  clientSettingsSnapshotRetryDelayMs,
  isClientSettingsSnapshotDue,
} from "../clientSettingsSnapshot";
import { reportForkClientUsage } from "../forkClientUsage";
import { useForkUsageEnvironmentId } from "../forkUsageEnvironment";
import { getClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import { useUiStateStore } from "../uiStateStore";

// A check is one storage read. Checking often retries soon after a report that
// failed because the cached server config arrived before the socket connected.
const CHECK_INTERVAL_MS = 60 * 1000;

function readLastReportedAt() {
  try {
    return localStorage.getItem(CLIENT_SETTINGS_SNAPSHOT_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Reports this device's preferences at most once a day through one server, so
 * client defaults can be judged the way `settings.snapshot` judges server ones.
 * The day restarts only when a server accepts the report; windows share it.
 */
export function ClientSettingsSnapshotReporter() {
  const hydrated = useClientSettingsHydrated();
  const environmentId = useForkUsageEnvironmentId();

  useEffect(() => {
    if (!hydrated || !environmentId) return;
    let pending = false;
    let failures = 0;
    let retryAt = 0;
    const reportIfDue = () => {
      const now = Date.now();
      if (pending || now < retryAt || !isClientSettingsSnapshotDue(readLastReportedAt(), now)) {
        return;
      }
      const report = reportForkClientUsage(
        environmentId,
        clientSettingsSnapshot(getClientSettings(), useUiStateStore.getState()),
      );
      if (!report) return;
      pending = true;
      void report.then((accepted) => {
        pending = false;
        if (!accepted) {
          failures += 1;
          // From the attempt, not the reply, so the next check on the interval qualifies.
          retryAt = now + clientSettingsSnapshotRetryDelayMs(failures);
          return;
        }
        failures = 0;
        try {
          localStorage.setItem(CLIENT_SETTINGS_SNAPSHOT_STORAGE_KEY, new Date().toISOString());
        } catch {
          // Without storage the next check reports again, which is harmless.
        }
      });
    };
    reportIfDue();
    const timer = window.setInterval(reportIfDue, CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [environmentId, hydrated]);

  return null;
}
