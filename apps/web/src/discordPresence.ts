import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentShellStatus,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  effectiveSettled,
  effectiveSnoozed,
  type ChangeRequestSettleSource,
} from "@t3tools/client-runtime/state/thread-settled";
import type {
  DesktopDiscordPresenceActivity,
  EnvironmentId,
  ServerConfig,
} from "@t3tools/contracts";
import type { ThreadChangeRequestSnapshot } from "./components/ThreadStatusIndicators";

/** Counts the active inbox across environments, independent of the current sidebar filter. */
export function deriveDiscordPresence({
  threads,
  serverConfigs,
  shellStatuses,
  changeRequests,
  now,
  autoSettleAfterDays,
  autoSettleOnMerge,
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
  changeRequests: ReadonlyMap<
    string,
    Pick<ThreadChangeRequestSnapshot, "branch" | "linkedPullRequest"> & {
      pr: ChangeRequestSettleSource;
    }
  >;
  now: string;
  autoSettleAfterDays: number | null;
  autoSettleOnMerge: boolean;
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
    const snapshot = changeRequests.get(
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    );
    const changeRequest =
      snapshot != null &&
      (thread.linkedPullRequest == null
        ? thread.worktreePath === null || snapshot.branch === thread.branch
        : snapshot.linkedPullRequest?.projectId === thread.linkedPullRequest.projectId &&
          snapshot.linkedPullRequest.repository === thread.linkedPullRequest.repository &&
          snapshot.linkedPullRequest.number === thread.linkedPullRequest.number)
        ? snapshot.pr
        : null;
    if (
      capabilities?.threadSettlement &&
      effectiveSettled(thread, {
        now: `${now.slice(0, 16)}:00.000Z`,
        autoSettleAfterDays,
        autoSettleOnMerge,
        changeRequest,
      })
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
