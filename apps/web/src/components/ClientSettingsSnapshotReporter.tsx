import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { useEffect } from "react";

import {
  CLIENT_SETTINGS_SNAPSHOT_STORAGE_KEY,
  clientSettingsSnapshot,
  isClientSettingsSnapshotDue,
} from "../clientSettingsSnapshot";
import { reportForkClientUsage, supportsForkClientUsage } from "../forkClientUsage";
import { getClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import { useServerConfigs } from "../state/entities";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { useUiStateStore } from "../uiStateStore";

// A check is one storage read. Checking often retries soon after a report that
// failed because the cached server config arrived before the socket connected.
const CHECK_INTERVAL_MS = 60 * 1000;

/** The primary environment, or on hosted web the first paired one, if it accepts the report. */
function reportingEnvironment(
  primaryId: EnvironmentId | null,
  configs: ReadonlyMap<EnvironmentId, ServerConfig>,
): EnvironmentId | null {
  if (primaryId) return supportsForkClientUsage(configs.get(primaryId)) ? primaryId : null;
  for (const [environmentId, config] of configs) {
    if (supportsForkClientUsage(config)) return environmentId;
  }
  return null;
}

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
  const environmentId = reportingEnvironment(
    useAtomValue(primaryEnvironmentIdAtom),
    useServerConfigs(),
  );

  useEffect(() => {
    if (!hydrated || !environmentId) return;
    let pending = false;
    const reportIfDue = () => {
      if (pending || !isClientSettingsSnapshotDue(readLastReportedAt(), Date.now())) return;
      const report = reportForkClientUsage(
        environmentId,
        clientSettingsSnapshot(getClientSettings(), useUiStateStore.getState()),
      );
      if (!report) return;
      pending = true;
      void report.then((accepted) => {
        pending = false;
        if (!accepted) return;
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
