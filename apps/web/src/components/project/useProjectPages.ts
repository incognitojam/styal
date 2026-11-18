import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import {
  countProjectThreads,
  formatProjectStatusLine,
  type ProjectChatHost,
  resolveProjectChatHost,
} from "./projectPage.logic";

export interface ProjectPage {
  readonly group: SidebarProjectSnapshot;
  readonly host: ProjectChatHost<SidebarProjectGroupMember>;
  /** `environmentId:threadId` of the chat, once it exists. */
  readonly chatThreadKey: string | null;
  readonly statusLine: string | null;
  /** The threads the status line counts as needing you. */
  readonly needYou: ReadonlyArray<EnvironmentThreadShell>;
}

/** Every project with a page (project coordinators on in Labs), by its logical project key. */
export function useProjectPages(): ReadonlyMap<string, ProjectPage> {
  const groups = useSettingsProjectGroups();
  const serverConfigs = useServerConfigs();
  const threads = useThreadShells();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectByThreadKey = new Map(
    threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread.projectId] as const),
  );
  const pages = new Map<string, ProjectPage>();
  const groupKeyByProject = new Map<string, string>();
  for (const group of groups) {
    if (group.isScratch || group.archived) continue;
    const host = resolveProjectChatHost(
      group.memberProjects,
      (environmentId) => serverConfigs.get(environmentId)?.settings,
      primaryEnvironmentId,
      (environmentId, threadId) => projectByThreadKey.get(`${environmentId}:${threadId}`) ?? null,
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
    });
  }
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
    const counts = countProjectThreads(threadsByPage.get(projectKey) ?? [], page.chatThreadKey);
    pages.set(projectKey, {
      ...page,
      statusLine: formatProjectStatusLine(counts),
      needYou: counts.needYou,
    });
  }
  return pages;
}
