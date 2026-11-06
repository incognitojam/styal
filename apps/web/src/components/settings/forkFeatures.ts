/**
 * Ledger ids (`.github/fork-features.yml`) of settings that exist only in
 * styal. A row passes one as `forkFeature` to show the styal mark beside its
 * title. Badge whole settings upstream lacks, not fork refinements of upstream
 * settings; retiring the ledger entry fails a test until the badge goes.
 */
export const SETTINGS_FORK_FEATURES = [
  "desktop-discord-rich-presence",
  "device-environment-hosts",
  "device-idle-shutdown",
  "physical-android-device-hold",
  "simulator-memory-profiles",
  "feedback-reports",
  "github-outage-status",
  "hardware-leases",
  "mentioned-time-chips",
  "project-agent-instructions",
  "provider-auto-updates",
  "sidebar-last-message-time",
  "sidebar-project-thread-groups",
  "source-control-fork-remotes",
  "turn-token-usage",
] as const;

export type SettingsForkFeature = (typeof SETTINGS_FORK_FEATURES)[number];

/**
 * Every settings search item upstream lacks, and the badge its row shows.
 * `check-settings-fork-badges.ts` fails a pull request whose new item is absent,
 * so each new styal setting gets a decision. Use `SETTINGS_NOT_BADGED` when the
 * row refines an upstream setting or sits under a badged one.
 */
export const SETTINGS_BADGED: Readonly<Record<string, SettingsForkFeature>> = {
  "agent-hardware-access": "hardware-leases",
  "discord-rich-presence": "desktop-discord-rich-presence",
  "environment-device-hosts": "device-environment-hosts",
  "group-threads-by-project": "sidebar-project-thread-groups",
  "send-feedback": "feedback-reports",
  "mentioned-time-check": "mentioned-time-chips",
  "outage-alerts": "github-outage-status",
  "physical-android-screen-off": "physical-android-device-hold",
  "provider-auto-updates": "provider-auto-updates",
  "simulator-memory": "simulator-memory-profiles",
  "thread-timestamp": "sidebar-last-message-time",
  "turn-usage": "turn-token-usage",
};

export const SETTINGS_NOT_BADGED: Readonly<Record<string, string>> = {
  "approval-sound": "Refines upstream notification sounds.",
  "completion-sound": "Refines upstream notification sounds.",
  "input-sound": "Refines upstream notification sounds.",
  "notification-sounds": "Refines upstream notification sounds.",
  "system-notifications": "Refines upstream notifications.",
  "project-agent-access": "Upstream has agent access under integrations.",
  "claude-outage-alerts": "Sits under the badged outage alerts row.",
  "github-outage-alerts": "Sits under the badged outage alerts row.",
  "openai-codex-outage-alerts": "Sits under the badged outage alerts row.",
  "hardware-devices": "Sits on the hardware page beside its badged access row.",
  "mentioned-time-check-model": "Sits under the badged time check row.",
  "project-simulator-memory": "Section holding the badged simulator memory row.",
  "turn-usage-figure": "Sits under the badged turn usage row.",
  "import-data": "A page with no setting row to badge.",
  "legacy-import-source": "A page with no setting row to badge.",
};
