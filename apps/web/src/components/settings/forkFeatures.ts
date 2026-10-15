/**
 * Ledger ids (`.github/fork-features.yml`) of settings that exist only in
 * styal. A row passes one as `forkFeature` to show the styal mark beside its
 * title. Badge whole settings upstream lacks, not fork refinements of upstream
 * settings; retiring the ledger entry fails a test until the badge goes.
 */
export const SETTINGS_FORK_FEATURES = [
  "desktop-discord-rich-presence",
  "device-environment-hosts",
  "github-outage-status",
  "project-agent-instructions",
  "provider-auto-updates",
  "sidebar-last-message-time",
  "sidebar-project-thread-groups",
  "source-control-fork-remotes",
  "turn-token-usage",
] as const;

export type SettingsForkFeature = (typeof SETTINGS_FORK_FEATURES)[number];
