/**
 * Every allowlisted key is sent on every report, so a missing key means an older server. Values
 * are booleans, enum literals and small integers only; record settings are reported as counts or
 * "customized", never their contents, paths, names, or ids.
 */
import {
  DEFAULT_SERVER_SETTINGS,
  globalIdleCompaction,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as ServerSettingsModule from "../serverSettings.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

/** The `settings.snapshot` properties for one server's settings. */
function settingsSnapshotProperties(settings: ServerSettings) {
  // Environment-wide rules; a project's own rules are counted in projectsWithOverrides.
  const worktreeCleanup = resolveWorktreeCleanup(settings, null);
  return {
    // New threads
    defaultRuntimeMode: settings.defaultRuntimeMode,
    // null inherits the repository's styal.json or legacy t3.json, then "local".
    defaultThreadEnvMode: settings.defaultThreadEnvMode ?? null,
    defaultModelSelectionSet: settings.defaultModelSelection !== null,
    responseStreamingMode: settings.responseStreamingMode,
    continueThreadsAfterServerUpdate: settings.continueThreadsAfterServerUpdate,
    // Worktrees and projects
    newWorktreesStartFromOrigin: settings.newWorktreesStartFromOrigin,
    worktreeSubmodules: settings.worktreeSubmodules,
    worktreesDirectoryCustomized: settings.worktreesDirectory !== "",
    defaultAutoPull: settings.defaultAutoPull,
    defaultProjectScriptCount: settings.defaultProjectScripts.length,
    projectsWithOverrides: Object.values(settings.projectSettingsOverrides).filter(
      (overrides) => Object.keys(overrides).length > 0,
    ).length,
    repositoriesWithApprovedFileActions: Object.values(settings.projectFileActionApprovals).filter(
      (approvals) => Object.keys(approvals).length > 0,
    ).length,
    // Thread settlement and limits
    sidebarAutoSettleOnMerge: settings.sidebarAutoSettleOnMerge,
    sidebarAutoSettleAfterDays:
      settings.sidebarAutoSettleAfterDays === null
        ? null
        : Math.round(settings.sidebarAutoSettleAfterDays),
    sidebarAutoSettleKeepPullRequests: settings.sidebarAutoSettleKeepPullRequests,
    snoozeLimitedThreads: settings.snoozeLimitedThreads,
    autoResumeLimitedThreads: settings.autoResumeLimitedThreads,
    guestSharingEnabled: settings.guestSharingEnabled,
    idleCompaction: globalIdleCompaction(settings),
    // Source control writing
    branchNamingMode: settings.branchNamingMode,
    branchNamePrefixCustomized:
      settings.branchNamePrefix !== DEFAULT_SERVER_SETTINGS.branchNamePrefix,
    textGenerationModelCustomized: !Equal.equals(
      settings.textGenerationModelSelection,
      DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
    ),
    threadTitleInstructionsCustomized: settings.threadTitleInstructions !== "",
    sourceControlWriterModelSet: settings.sourceControlWriterModelSelection !== null,
    sourceControlWritingStyleMode: settings.sourceControlWritingStyle.mode,
    followChangeRequestTemplates: settings.sourceControlWritingStyle.followChangeRequestTemplates,
    removeAgentCreditsOnMerge: settings.removeAgentCreditsOnMerge,
    // null reuses the method last chosen on the device.
    pullRequestMergeMethod: settings.pullRequestMergeMethod,
    reviewGuidesEnabled: settings.reviewGuidesEnabled,
    reviewGuideModelSet: settings.reviewGuideModelSelection !== null,
    reviewGuideInstructionsCustomized: settings.reviewGuideInstructions !== "",
    // Storage cleanup
    worktreeCleanupKeepWhen: worktreeCleanup.worktreeKeepWhen,
    worktreeCleanupAfterDays: worktreeCleanup.worktreeAfterDays,
    worktreeCleanupOnMerge: worktreeCleanup.worktreeOnMerge,
    worktreeCleanupOnDelete: worktreeCleanup.worktreeOnDelete,
    worktreeCleanupUnchanged: worktreeCleanup.worktreeUnchanged,
    browserArtifactsCleanupAfterDays: settings.storageCleanup.browserArtifactsAfterDays,
    logsCleanupAfterDays: settings.storageCleanup.logsAfterDays,
    // Agent access and devices
    enableAgentBrowserAccess: settings.enableAgentBrowserAccess,
    enableAgentDeviceAccess: settings.enableAgentDeviceAccess,
    enableAgentHardwareAccess: settings.enableAgentHardwareAccess,
    enableDeviceSupport: settings.enableDeviceSupport,
    // null keeps devices running.
    deviceIdleShutdownMinutes: settings.deviceIdleShutdownMinutes,
    keepPhysicalAndroidScreensOff: settings.keepPhysicalAndroidScreensOff,
    simulatorMemoryMode: settings.simulatorMemoryMode,
    projectsWithLowMemoryMode: Object.values(settings.projectSettingsOverrides).filter(
      (override) => override.simulatorMemoryMode === "low-memory",
    ).length,
    cursorKeychainUsageEnabled: settings.cursorKeychainUsageEnabled,
    backgroundActivityProfile: settings.backgroundActivity.profile,
  };
}

// Same cadence as provider.inventory.
const FIRST_REPORT_DELAY = Duration.minutes(2);
const REPORT_INTERVAL = Duration.hours(24);

const reportSettingsSnapshot = Effect.gen(function* () {
  const analytics = yield* AnalyticsService.AnalyticsService;
  const settings = yield* (yield* ServerSettingsModule.ServerSettingsService).getSettings;
  yield* analytics.record("settings.snapshot", settingsSnapshotProperties(settings));
}).pipe(
  Effect.catchCause((cause) => Effect.logDebug("Settings snapshot report failed", { cause })),
);

/** Reports the settings snapshot after startup settles, then daily, without blocking startup. */
export const layer = Layer.effectDiscard(
  Effect.sleep(FIRST_REPORT_DELAY).pipe(
    Effect.andThen(reportSettingsSnapshot.pipe(Effect.repeat(Schedule.spaced(REPORT_INTERVAL)))),
    Effect.forkScoped,
  ),
);
