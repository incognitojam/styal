import type { MobileSettingsSnapshot } from "@t3tools/contracts";

import { resolveAppearancePreferences } from "../../lib/appearancePreferences";
import { DEFAULT_COMPOSER_ENTER_BEHAVIOR } from "../../lib/composerEnterBehavior";
import { DEFAULT_FOLLOW_UP_BEHAVIOR } from "../../lib/followUpBehavior";
import { MICROPHONE_KINDS, microphoneOrder } from "../../lib/microphonePriority";
import { normalizeMobileThemeMode, resolveMobileThemeIds } from "../../lib/mobileTheme";
import type { Preferences } from "../../persistence/mobile-preferences";
import { resolveMobileProjectGroupingSettings } from "../../state/project-grouping.logic";
import { DEFAULT_ATTENDED_ALERT_DELAY_SECONDS } from "../agent-awareness/registrationPayload";

/** When this device last had its settings snapshot accepted by a server. */
export const MOBILE_SETTINGS_SNAPSHOT_STORAGE_KEY = "styal.settings-snapshot.reported-at";

// Connected headsets are remembered just above their kind, so only a kind
// sequence that differs from the default means the user reordered the list.
function microphoneOrderCustomized(saved: Preferences["microphones"]): boolean {
  const kinds = microphoneOrder(saved)
    .map((entry) => entry.kind)
    .filter((kind, index, all) => index === 0 || all[index - 1] !== kind);
  return kinds.join() !== MICROPHONE_KINDS.join();
}

/**
 * The effective value of each preference on this phone, with unset ones
 * resolved to the default the app applies. See `NOT_REPORTED` in the test for
 * what stays on the device.
 */
export function mobileSettingsSnapshot(
  preferences: Preferences,
  device: { readonly notificationsEnabled: boolean },
): MobileSettingsSnapshot {
  const appearance = resolveAppearancePreferences(preferences);
  const themeIds = resolveMobileThemeIds(preferences);
  return {
    feature: "mobile-settings",
    action: "snapshot",
    notificationsEnabled: device.notificationsEnabled,
    liveActivitiesEnabled: preferences.liveActivitiesEnabled !== false,
    notifyOnApproval: preferences.notifyOnApproval !== false,
    notifyOnInput: preferences.notifyOnInput !== false,
    notifyOnCompletion: preferences.notifyOnCompletion !== false,
    notifyOnFailure: preferences.notifyOnFailure !== false,
    attendedAlertDelaySeconds:
      preferences.attendedAlertDelaySeconds ?? DEFAULT_ATTENDED_ALERT_DELAY_SECONDS,
    composerEnterBehavior: preferences.composerEnterBehavior ?? DEFAULT_COMPOSER_ENTER_BEHAVIOR,
    followUpBehavior: preferences.followUpBehavior ?? DEFAULT_FOLLOW_UP_BEHAVIOR,
    planModeEnabled: preferences.planModeEnabled === true,
    turnUsageEnabled: preferences.turnUsageEnabled !== false,
    turnUsageFigure: preferences.turnUsageFigure === "cost" ? "cost" : "tokens",
    confirmThreadUnpin: preferences.confirmThreadUnpin !== false,
    threadTimestampMode: preferences.threadTimestampMode ?? "last_prompted",
    threadGrouping: preferences.threadGrouping === "project" ? "project" : "none",
    projectGroupingMode:
      resolveMobileProjectGroupingSettings(preferences).sidebarProjectGroupingMode,
    workingShelfEnabled: preferences.workingShelfEnabled === true,
    threadListWorkingShelfExpanded: preferences.threadListWorkingShelfExpanded === true,
    threadListSettledShelfExpanded: preferences.threadListSettledShelfExpanded === true,
    threadListSnoozedShelfExpanded: preferences.threadListSnoozedShelfExpanded === true,
    modelFavoriteCount: preferences.modelFavorites?.length ?? 0,
    microphoneOrderCustomized: microphoneOrderCustomized(preferences.microphones),
    themeMode: normalizeMobileThemeMode(preferences.themeMode),
    lightThemeId: themeIds.light,
    darkThemeId: themeIds.dark,
    baseFontSize: appearance.baseFontSize,
    terminalFontSize: appearance.terminalFontSize,
    codeFontSize: appearance.codeFontSize,
    codeWordBreak: appearance.codeWordBreak,
    mathRenderingEnabled: preferences.mathRenderingEnabled === true,
    diffSortMode: preferences.diffSortMode === "alphabetical" ? "alphabetical" : "relevance",
    pullRequestHideTestFiles: preferences.pullRequestHideTestFiles === true,
    pullRequestMergeMethod: preferences.pullRequestMergeMethod ?? "squash",
  };
}
