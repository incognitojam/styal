import { useAtomValue } from "@effect/atom-react";
import { startSettingsSnapshotReports } from "@t3tools/client-runtime/settings-snapshot";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { useEffect } from "react";

import { loadPreferences } from "../../persistence/imperative";
import { reportForkClientUsage, supportsForkClientUsage } from "../../state/forkClientUsage";
import { environmentServerConfigsAtom } from "../../state/server";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { supportsAgentAwarenessPush } from "../agent-awareness/capabilities";
import {
  MOBILE_SETTINGS_SNAPSHOT_STORAGE_KEY,
  mobileSettingsSnapshot,
} from "./mobileSettingsSnapshot";

async function notificationsEnabled() {
  if (!supportsAgentAwarenessPush()) return false;
  const permission = await Notifications.getPermissionsAsync().catch(() => null);
  return permission?.granted === true;
}

/**
 * Reports this phone's preferences at most once a day through the first
 * connected environment that accepts them, like web's settings snapshot.
 */
export function MobileSettingsSnapshotReporter() {
  const configs = useAtomValue(environmentServerConfigsAtom);
  // Saved environments keep their last config while offline, so a report
  // through one of them would fail until it reconnects.
  const environmentId =
    useWorkspaceEnvironments().find(
      (environment) =>
        environment.connectionState === "connected" &&
        supportsForkClientUsage(configs.get(environment.environmentId)),
    )?.environmentId ?? null;

  useEffect(() => {
    if (!environmentId) return;
    return startSettingsSnapshotReports({
      readLastReportedAt: () => SecureStore.getItemAsync(MOBILE_SETTINGS_SNAPSHOT_STORAGE_KEY),
      saveReportedAt: (reportedAt) =>
        SecureStore.setItemAsync(MOBILE_SETTINGS_SNAPSHOT_STORAGE_KEY, reportedAt),
      report: async () =>
        reportForkClientUsage(
          environmentId,
          mobileSettingsSnapshot(await loadPreferences(), {
            notificationsEnabled: await notificationsEnabled(),
          }),
        ),
    });
  }, [environmentId]);

  return null;
}
