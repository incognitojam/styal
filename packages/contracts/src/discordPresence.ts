import type { DesktopDiscordPresenceActivity } from "./ipc.ts";

/** The Discord activity line, shared by the desktop publisher and the settings preview. */
export function formatDiscordPresenceDetails(activity: DesktopDiscordPresenceActivity): string {
  return `${activity.activeThreads} active ${activity.activeThreads === 1 ? "thread" : "threads"} across ${activity.activeProjects} ${activity.activeProjects === 1 ? "project" : "projects"}`;
}

export const DISCORD_PRESENCE_BUTTON = {
  label: "View on GitHub",
  url: "https://github.com/incognitojam/styal",
};
