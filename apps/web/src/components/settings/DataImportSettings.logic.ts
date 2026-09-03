import {
  type BackgroundActivityProfile,
  LegacyImportPreferences,
  type LegacyImportPreferences as LegacyImportPreferencesValue,
  type LegacyImportPreview,
  type ServerSettings,
  type SourceControlWritingStyleMode,
  type ThreadEnvMode,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import {
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import * as Struct from "effect/Struct";

const BACKGROUND_ACTIVITY_PROFILE_LABELS: Readonly<Record<BackgroundActivityProfile, string>> = {
  balanced: "Balanced",
  performance: "Performance",
  "battery-saver": "Battery saver",
};

const THREAD_ENV_MODE_LABELS: Readonly<Record<ThreadEnvMode, string>> = {
  local: "Local checkout",
  worktree: "New worktree",
};

const WRITING_STYLE_LABELS: Readonly<Record<SourceControlWritingStyleMode, string>> = {
  repo_conventions: "Repository conventions",
  conventional_commits: "Conventional Commits",
  custom: "Custom instructions",
};

export interface PreferenceRow {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  /** The effective value, kept separate so presentation formatting cannot hide a change. */
  readonly comparisonValue: string | number | boolean;
  /** Paths read better monospaced and must not be paraphrased. */
  readonly monospace?: boolean;
}

export interface PreferenceComparisonRow {
  readonly row: PreferenceRow;
  readonly current: PreferenceRow | undefined;
  readonly changed: boolean;
}

export const LEGACY_IMPORT_PREFERENCE_KEYS = Struct.keys(LegacyImportPreferences.fields);
export const LEGACY_IMPORT_PREFERENCE_COUNT = LEGACY_IMPORT_PREFERENCE_KEYS.length;

function formatCount(value: number): string {
  return value.toLocaleString();
}

/** "Every 30 seconds" / "Every 5 minutes" / "Off", so a duration reads as a schedule. */
function formatIntervalValue(duration: Duration.Duration): string {
  const seconds = Math.round(Duration.toMillis(duration) / 1_000);
  if (seconds <= 0) return "Off";
  return `Every ${formatDurationValue(duration)}`;
}

function formatDurationValue(duration: Duration.Duration): string {
  const seconds = Math.round(Duration.toMillis(duration) / 1_000);
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `${formatCount(hours)} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${formatCount(minutes)} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `${formatCount(seconds)} ${seconds === 1 ? "second" : "seconds"}`;
}

function activityComparisonValue(
  resolved: ReturnType<typeof resolveServerBackgroundActivitySettings>,
  customized: boolean,
): string {
  return JSON.stringify([
    resolved.profile,
    customized,
    Duration.toMillis(resolved.automaticGitFetchInterval),
    Duration.toMillis(resolved.providerHealthRefreshInterval),
    Duration.toMillis(resolved.hostPowerMonitorActiveInterval),
    Duration.toMillis(resolved.hostPowerMonitorIdleInterval),
    Duration.toMillis(resolved.idleClientTtl),
    resolved.pauseWhenHostLocked,
    resolved.pauseWhenHostLowPower,
    resolved.pauseWhenClientLowPower,
    resolved.pauseWhenOnBattery,
  ]);
}

/** The exact effective values an "Import preferences" run would write. */
export function buildPreferenceRows(
  values: LegacyImportPreferencesValue,
): readonly PreferenceRow[] {
  const resolved = resolveServerBackgroundActivitySettings({
    ...DEFAULT_SERVER_SETTINGS,
    ...values,
  });
  const preset = getBackgroundActivityPresetSettings(resolved.profile);
  const activityCustomized =
    values.backgroundActivity.profile === "custom" ||
    Duration.toMillis(resolved.automaticGitFetchInterval) !==
      Duration.toMillis(preset.automaticGitFetchInterval) ||
    Duration.toMillis(resolved.providerHealthRefreshInterval) !==
      Duration.toMillis(preset.providerHealthRefreshInterval);
  const writingStyle = values.sourceControlWritingStyle;
  const addProjectBaseDirectory = values.addProjectBaseDirectory.trim();

  return [
    {
      id: "background-activity",
      label: "Background activity policy",
      value: activityCustomized
        ? `${BACKGROUND_ACTIVITY_PROFILE_LABELS[resolved.profile]} (customized)`
        : BACKGROUND_ACTIVITY_PROFILE_LABELS[resolved.profile],
      comparisonValue: activityComparisonValue(resolved, activityCustomized),
    },
    {
      id: "git-fetch",
      label: "Automatic Git fetch",
      value: formatIntervalValue(resolved.automaticGitFetchInterval),
      comparisonValue: Duration.toMillis(resolved.automaticGitFetchInterval),
    },
    {
      id: "provider-health",
      label: "Provider health refresh",
      value: formatIntervalValue(resolved.providerHealthRefreshInterval),
      comparisonValue: Duration.toMillis(resolved.providerHealthRefreshInterval),
    },
    {
      id: "host-power-monitor",
      label: "Host power monitor",
      value: formatIntervalValue(resolved.hostPowerMonitorActiveInterval),
      comparisonValue: Duration.toMillis(resolved.hostPowerMonitorActiveInterval),
    },
    {
      id: "idle-host-monitor",
      label: "Idle host monitor",
      value: formatIntervalValue(resolved.hostPowerMonitorIdleInterval),
      comparisonValue: Duration.toMillis(resolved.hostPowerMonitorIdleInterval),
    },
    {
      id: "idle-client-timeout",
      label: "Idle client timeout",
      value: formatDurationValue(resolved.idleClientTtl),
      comparisonValue: Duration.toMillis(resolved.idleClientTtl),
    },
    {
      id: "pause-host-locked",
      label: "Pause when host is locked",
      value: resolved.pauseWhenHostLocked ? "On" : "Off",
      comparisonValue: resolved.pauseWhenHostLocked,
    },
    {
      id: "pause-host-low-power",
      label: "Pause on host low power",
      value: resolved.pauseWhenHostLowPower ? "On" : "Off",
      comparisonValue: resolved.pauseWhenHostLowPower,
    },
    {
      id: "pause-client-low-power",
      label: "Pause on client low power",
      value: resolved.pauseWhenClientLowPower ? "On" : "Off",
      comparisonValue: resolved.pauseWhenClientLowPower,
    },
    {
      id: "pause-on-battery",
      label: "Pause on battery",
      value: resolved.pauseWhenOnBattery ? "On" : "Off",
      comparisonValue: resolved.pauseWhenOnBattery,
    },
    {
      id: "provider-update-checks",
      label: "Provider update checks",
      value: values.enableProviderUpdateChecks ? "On" : "Off",
      comparisonValue: values.enableProviderUpdateChecks,
    },
    {
      id: "new-threads",
      label: "New threads start in",
      value: THREAD_ENV_MODE_LABELS[values.defaultThreadEnvMode],
      comparisonValue: values.defaultThreadEnvMode,
    },
    {
      id: "start-from-origin",
      label: "New worktrees start from",
      value: values.newWorktreesStartFromOrigin ? "Origin" : "Local branch",
      comparisonValue: values.newWorktreesStartFromOrigin,
    },
    {
      id: "add-project-starts-in",
      label: "Add project starts in",
      value: addProjectBaseDirectory === "" ? "~/ (default)" : addProjectBaseDirectory,
      comparisonValue: addProjectBaseDirectory,
      monospace: addProjectBaseDirectory !== "",
    },
    {
      id: "source-control-writing-style",
      label: "Source control writing style",
      value: WRITING_STYLE_LABELS[writingStyle.mode],
      comparisonValue: writingStyle.mode,
    },
    {
      id: "source-control-writing-instructions",
      label: "Source control custom instructions",
      value: writingStyle.customInstructions || "None",
      comparisonValue: writingStyle.customInstructions,
    },
    {
      id: "change-request-templates",
      label: "Follow change request templates",
      value: writingStyle.followChangeRequestTemplates ? "On" : "Off",
      comparisonValue: writingStyle.followChangeRequestTemplates,
    },
    {
      id: "agent-browser-access",
      label: "Agent browser access",
      value: values.enableAgentBrowserAccess ? "Allowed" : "Blocked",
      comparisonValue: values.enableAgentBrowserAccess,
    },
    {
      id: "legacy-token-streaming",
      label: "Stream token by token (legacy)",
      value: values.enableLegacyTokenStreaming ? "On" : "Off",
      comparisonValue: values.enableLegacyTokenStreaming,
    },
  ];
}

export function buildPreferenceComparisonRows(
  imported: LegacyImportPreferencesValue,
  current: LegacyImportPreferencesValue,
): readonly PreferenceComparisonRow[] {
  const currentRows = buildPreferenceRows(current);
  const currentRowsById = new Map(currentRows.map((row) => [row.id, row]));
  const rows = buildPreferenceRows(imported).map((row) => {
    const currentRow = currentRowsById.get(row.id);
    return {
      row,
      current: currentRow,
      changed: currentRow?.comparisonValue !== row.comparisonValue,
    };
  });
  return [...rows.filter(({ changed }) => changed), ...rows.filter(({ changed }) => !changed)];
}

/** Pick the allowlist from its contract so newly-added fields cannot silently drift here. */
export function selectLegacyImportPreferences(
  values: ServerSettings,
): LegacyImportPreferencesValue {
  return Object.fromEntries(LEGACY_IMPORT_PREFERENCE_KEYS.map((key) => [key, values[key]])) as {
    [Key in (typeof LEGACY_IMPORT_PREFERENCE_KEYS)[number]]: ServerSettings[Key];
  };
}

/** Poll decoding creates fresh objects; preserve references when the preview is unchanged. */
export function legacyImportPreviewsEqual(
  left: LegacyImportPreview | null,
  right: LegacyImportPreview | null,
): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}
