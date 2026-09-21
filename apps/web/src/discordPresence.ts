import type {
  EnvironmentShellStatus,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type {
  DesktopDiscordPresenceActivity,
  EnvironmentId,
  ServerConfig,
} from "@t3tools/contracts";

/** Counts the active inbox across environments, independent of the current sidebar filter. */
export function deriveDiscordPresence({
  threads,
  serverConfigs,
  shellStatuses,
  now,
}: {
  threads: ReadonlyArray<EnvironmentThreadShell>;
  serverConfigs: ReadonlyMap<
    EnvironmentId,
    {
      environment: {
        capabilities: Pick<
          ServerConfig["environment"]["capabilities"],
          "threadSettlement" | "threadSnooze"
        >;
      };
    }
  >;
  shellStatuses: ReadonlyMap<EnvironmentId, EnvironmentShellStatus>;
  now: string;
}): { activity: DesktopDiscordPresenceActivity | null; nextWakeAt: number | null } {
  const projects = new Set<string>();
  let activeThreads = 0;
  let nextWakeAt: number | null = null;
  for (const thread of threads) {
    // Cached/disconnected environments must not keep advertising stale activity.
    if (thread.archivedAt !== null || shellStatuses.get(thread.environmentId) !== "live") continue;
    const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
    if (capabilities?.threadSnooze && effectiveSnoozed(thread, { now })) {
      const wakeAt = Date.parse(thread.snoozedUntil!);
      nextWakeAt = nextWakeAt === null ? wakeAt : Math.min(nextWakeAt, wakeAt);
      continue;
    }
    if (
      capabilities?.threadSettlement &&
      thread.settledOverride === "settled" &&
      !thread.hasPendingApprovals &&
      !thread.hasPendingUserInput
    )
      continue;
    activeThreads += 1;
    projects.add(`${thread.environmentId}\0${thread.projectId}`);
  }
  return {
    activity: activeThreads > 0 ? { activeThreads, activeProjects: projects.size } : null,
    nextWakeAt,
  };
}
