import * as Schema from "effect/Schema";

import type { DesktopDiscordPresenceActivity } from "./ipc.ts";

/** The Discord activity line, shared by the desktop publisher and the settings preview. */
export function formatDiscordPresenceDetails(activity: DesktopDiscordPresenceActivity): string {
  return `${activity.activeThreads} active ${activity.activeThreads === 1 ? "thread" : "threads"} across ${activity.activeProjects} ${activity.activeProjects === 1 ? "project" : "projects"}`;
}

export const DISCORD_PRESENCE_BUTTON = {
  label: "View on GitHub",
  url: "https://github.com/incognitojam/styal",
};

/**
 * The desktop's connection to the local Discord app. `idle` means nothing is
 * being shared, so Discord is not contacted; `connected` means Discord accepted
 * the activity, though its own privacy settings may still hide it from others.
 */
export const DesktopDiscordPresenceStatus = Schema.Union([
  Schema.TaggedStruct("idle", {}),
  Schema.TaggedStruct("connecting", {}),
  Schema.TaggedStruct("connected", { username: Schema.String }),
  Schema.TaggedStruct("unavailable", {}),
]);
export type DesktopDiscordPresenceStatus = typeof DesktopDiscordPresenceStatus.Type;
