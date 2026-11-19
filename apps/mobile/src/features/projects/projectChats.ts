import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { mobilePreferencesAtom } from "../../state/preferences";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import {
  DEFAULT_MOBILE_PROJECT_GROUPING_SETTINGS,
  resolveMobileProjectGroupingSettings,
} from "../../state/project-grouping.logic";
import { environmentProjects } from "../../state/projects";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { buildHomeProjectScopes } from "../home/homeThreadList";
import {
  buildProjectChats,
  projectChatHeadersEqual,
  type ProjectChatHeader,
  type ProjectChats,
} from "./projectChats.logic";

export const projectChatsAtom = Atom.make((get): ProjectChats => {
  const preferences = get(mobilePreferencesAtom);
  const grouping = AsyncResult.isSuccess(preferences)
    ? resolveMobileProjectGroupingSettings(preferences.value)
    : DEFAULT_MOBILE_PROJECT_GROUPING_SETTINGS;
  const configs = get(environmentServerConfigsAtom);
  const connected = new Set(get(connectedEnvironmentIdsAtom));
  return buildProjectChats({
    scopes: buildHomeProjectScopes({
      projects: get(environmentProjects.projectsAtom),
      environmentId: null,
      projectGroupingMode: grouping.sidebarProjectGroupingMode,
    }),
    threads: get(environmentThreadShells.threadShellsAtom),
    settingsFor: (environmentId) => configs.get(environmentId)?.settings,
    connected: (environmentId) => connected.has(environmentId),
  });
}).pipe(Atom.withLabel("mobile-project-chats"));

// Keeps the same value while title and count are unchanged, so the open chat's screen does not
// re-render on every streaming update to some other thread's shell.
const projectChatHeaderAtom = Atom.family((threadKey: string) => {
  let previous: ProjectChatHeader | null = null;
  return Atom.make((get) => {
    const chat = get(projectChatsAtom).byChatKey.get(threadKey);
    const next: ProjectChatHeader | null =
      chat === undefined
        ? null
        : {
            scopeKey: chat.scopeKey,
            title: chat.title,
            projectId: chat.projectId,
            working: chat.working,
          };
    if (!projectChatHeadersEqual(previous, next)) previous = next;
    return previous;
  }).pipe(Atom.withLabel(`mobile-project-chat-header:${threadKey}`));
});

const NO_PROJECT_CHAT_HEADER_ATOM = Atom.make<ProjectChatHeader | null>(null).pipe(
  Atom.withLabel("mobile-project-chat-header:none"),
);

export function useProjectChats(): ProjectChats {
  return useAtomValue(projectChatsAtom);
}

/** Set when the thread is its project's chat, which then shows as the project's screen. */
export function useProjectChatHeader(ref: ScopedThreadRef | null): ProjectChatHeader | null {
  return useAtomValue(
    ref === null
      ? NO_PROJECT_CHAT_HEADER_ATOM
      : projectChatHeaderAtom(scopedThreadKey(ref.environmentId, ref.threadId)),
  );
}
