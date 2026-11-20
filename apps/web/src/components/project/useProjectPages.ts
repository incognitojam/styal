import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { getThreadSortTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import type { ScheduledTaskThread } from "@t3tools/contracts";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { environmentIdsKey } from "../../state/environmentAtomList";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  useEnvironmentShellStatuses,
  useServerConfigs,
  useThreadShells,
} from "../../state/entities";
import { projectJobListsAtom } from "../../state/server";
import { isThreadRouteSnapshotAuthoritative } from "../../threadRoutes";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import {
  countProjectThreads,
  formatProjectStatusLine,
  type ProjectChatHost,
  resolveProjectChatHost,
} from "@t3tools/client-runtime/project-page";
import { isProjectPageJob, jobRunsAgain, jobThreadsSince } from "./projectPage.logic";

/** A task that runs in a thread the project page keeps. */
export interface ProjectPageJob {
  readonly thread: EnvironmentThreadShell;
  readonly task: ScheduledTaskThread;
  /** The machine's zone for fixed-time schedules. */
  readonly timeZone: string | undefined;
}

export interface ProjectPage {
  readonly group: SidebarProjectSnapshot;
  readonly host: ProjectChatHost<SidebarProjectGroupMember>;
  /** `environmentId:threadId` of the chat, once it exists. */
  readonly chatThreadKey: string | null;
  readonly statusLine: string | null;
  /** The threads the status line counts as needing you. */
  readonly needYou: ReadonlyArray<EnvironmentThreadShell>;
  /** Tasks whose threads the page keeps (`isProjectPageJob`), latest thread activity first. */
  readonly jobs: ReadonlyArray<ProjectPageJob>;
  /** `jobThreadsSince` of those threads, by `environmentId:threadId`. */
  readonly jobsSince: ReadonlyMap<string, number>;
}

/** Every project with a page (project coordinators on in Labs), by its logical project key. */
export function useProjectPages(): ReadonlyMap<string, ProjectPage> {
  const groups = useSettingsProjectGroups();
  const serverConfigs = useServerConfigs();
  const threads = useThreadShells();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const shellStatuses = useEnvironmentShellStatuses();
  const projectByThreadKey = new Map(
    threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread.projectId] as const),
  );
  const activityByThreadKey = new Map(
    threads.map(
      (thread) =>
        [
          `${thread.environmentId}:${thread.id}`,
          getThreadSortTimestamp(thread, "updated_at"),
        ] as const,
    ),
  );
  const activityByCheckout = new Map<string, number>();
  for (const thread of threads) {
    const key = `${thread.environmentId}:${thread.projectId}`;
    const at = getThreadSortTimestamp(thread, "updated_at");
    if (at > (activityByCheckout.get(key) ?? Number.NEGATIVE_INFINITY)) {
      activityByCheckout.set(key, at);
    }
  }
  const pages = new Map<string, ProjectPage>();
  const groupKeyByProject = new Map<string, string>();
  for (const group of groups) {
    if (group.isScratch || group.archived) continue;
    const host = resolveProjectChatHost(
      group.memberProjects,
      (environmentId) => serverConfigs.get(environmentId)?.settings,
      primaryEnvironmentId,
      (environmentId, threadId) => projectByThreadKey.get(`${environmentId}:${threadId}`) ?? null,
      {
        checkoutActivityAt: (checkout) =>
          activityByCheckout.get(`${checkout.environmentId}:${checkout.id}`) ??
          Number.NEGATIVE_INFINITY,
        chatActivityAt: (environmentId, threadId) =>
          activityByThreadKey.get(`${environmentId}:${threadId}`) ?? Number.NEGATIVE_INFINITY,
        connected: (environmentId) =>
          isThreadRouteSnapshotAuthoritative(shellStatuses.get(environmentId)),
      },
    );
    if (host === null) continue;
    for (const member of group.memberProjects) {
      groupKeyByProject.set(`${member.environmentId}:${member.id}`, group.projectKey);
    }
    pages.set(group.projectKey, {
      group,
      host,
      chatThreadKey:
        host.chatThreadId === null ? null : `${host.checkout.environmentId}:${host.chatThreadId}`,
      statusLine: null,
      needYou: [],
      jobs: [],
      jobsSince: new Map(),
    });
  }
  const environmentIds = [
    ...new Set(
      [...pages.values()].flatMap((page) =>
        page.group.memberProjects.map((member) => member.environmentId),
      ),
    ),
  ].toSorted();
  const jobLists = useAtomValue(projectJobListsAtom(environmentIdsKey(environmentIds)));
  // A machine whose list has not loaded keeps no thread off the sidebar.
  const jobListByEnvironment = new Map(
    environmentIds.flatMap((id, index) => {
      const list = jobLists[index];
      return list ? [[id, { ...list, since: jobThreadsSince(list.tasks) }] as const] : [];
    }),
  );
  if (pages.size === 0) return pages;
  const threadsByPage = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    const projectKey = groupKeyByProject.get(`${thread.environmentId}:${thread.projectId}`);
    if (projectKey === undefined) continue;
    const list = threadsByPage.get(projectKey);
    if (list) list.push(thread);
    else threadsByPage.set(projectKey, [thread]);
  }
  for (const [projectKey, page] of pages) {
    const pageThreads = threadsByPage.get(projectKey) ?? [];
    const counts = countProjectThreads(pageThreads, page.chatThreadKey);
    const jobs: ProjectPageJob[] = [];
    const jobsSince = new Map<string, number>();
    for (const thread of pageThreads) {
      const list = jobListByEnvironment.get(thread.environmentId);
      const since = list?.since.get(thread.id);
      if (
        list === undefined ||
        since === undefined ||
        !isProjectPageJob(
          thread,
          list.since,
          serverConfigs.get(thread.environmentId)?.settings,
          page.group,
        )
      ) {
        continue;
      }
      jobsSince.set(`${thread.environmentId}:${thread.id}`, since);
      for (const task of list.tasks) {
        if (task.threadId === thread.id && jobRunsAgain(task)) {
          jobs.push({ thread, task, timeZone: list.timeZone });
        }
      }
    }
    pages.set(projectKey, {
      ...page,
      statusLine: formatProjectStatusLine(counts),
      needYou: counts.needYou,
      jobs: jobs.toSorted(
        (left, right) =>
          getThreadSortTimestamp(right.thread, "updated_at") -
          getThreadSortTimestamp(left.thread, "updated_at"),
      ),
      jobsSince,
    });
  }
  return pages;
}
