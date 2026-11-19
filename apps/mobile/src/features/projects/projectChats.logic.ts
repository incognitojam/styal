import {
  countProjectThreads,
  formatProjectStatusLine,
  resolveProjectChatHost,
} from "@t3tools/client-runtime/project-page";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { getThreadSortTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, ProjectId, ServerSettings } from "@t3tools/contracts";

import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import type { HomeProjectScope } from "../home/homeThreadList";

/** A project whose coordinator thread exists: the thread opens as the project's screen. */
export interface ProjectChat {
  readonly scopeKey: string;
  readonly title: string;
  readonly project: EnvironmentProject;
  /** The chat's checkout, for project settings and new threads. */
  readonly projectId: ProjectId;
  readonly chat: EnvironmentThreadShell;
  readonly working: number;
  /** "2 working · 1 needs you", or null when neither. */
  readonly statusLine: string | null;
}

export interface ProjectChats {
  readonly byChatKey: ReadonlyMap<string, ProjectChat>;
  readonly byScopeKey: ReadonlyMap<string, ProjectChat>;
  /** `environmentId:projectId` of every checkout of a project with a chat. */
  readonly byCheckoutKey: ReadonlyMap<string, ProjectChat>;
}

export const NO_PROJECT_CHATS: ProjectChats = {
  byChatKey: new Map(),
  byScopeKey: new Map(),
  byCheckoutKey: new Map(),
};

type CoordinatorSettings = Pick<
  ServerSettings,
  "projectCoordinatorsEnabled" | "projectCoordinators"
>;

/**
 * Project chats from the same project scopes as the thread list, with the web project page's
 * rules for which machine's coordinator is the chat. A named chat this client has no shell for
 * yet is left out, so nothing opens a thread it cannot show.
 */
export function buildProjectChats(input: {
  readonly scopes: ReadonlyArray<HomeProjectScope>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly settingsFor: (environmentId: EnvironmentId) => CoordinatorSettings | undefined;
  readonly connected: (environmentId: EnvironmentId) => boolean;
}): ProjectChats {
  const shellByKey = new Map<string, EnvironmentThreadShell>();
  const activityByCheckout = new Map<string, number>();
  for (const thread of input.threads) {
    shellByKey.set(scopedThreadKey(thread.environmentId, thread.id), thread);
    const key = scopedProjectKey(thread.environmentId, thread.projectId);
    const at = getThreadSortTimestamp(thread, "updated_at");
    if (at > (activityByCheckout.get(key) ?? Number.NEGATIVE_INFINITY)) {
      activityByCheckout.set(key, at);
    }
  }
  const byChatKey = new Map<string, ProjectChat>();
  const byScopeKey = new Map<string, ProjectChat>();
  const byCheckoutKey = new Map<string, ProjectChat>();
  const scopeKeyByCheckout = new Map<string, string>();
  const chatScopes: Array<{ readonly scope: HomeProjectScope; readonly chatKey: string }> = [];
  for (const scope of input.scopes) {
    if (scope.archived) continue;
    const host = resolveProjectChatHost(
      scope.projects.map((project) => ({ environmentId: project.environmentId, id: project.id })),
      input.settingsFor,
      null,
      (environmentId, threadId) =>
        shellByKey.get(scopedThreadKey(environmentId, threadId))?.projectId ?? null,
      {
        checkoutActivityAt: (checkout) =>
          activityByCheckout.get(scopedProjectKey(checkout.environmentId, checkout.id)) ??
          Number.NEGATIVE_INFINITY,
        chatActivityAt: (environmentId, threadId) => {
          const shell = shellByKey.get(scopedThreadKey(environmentId, threadId));
          return shell ? getThreadSortTimestamp(shell, "updated_at") : Number.NEGATIVE_INFINITY;
        },
        connected: input.connected,
      },
    );
    if (host === null || host.chatThreadId === null) continue;
    const chatKey = scopedThreadKey(host.checkout.environmentId, host.chatThreadId);
    if (!shellByKey.has(chatKey)) continue;
    for (const ref of scope.projectRefs) {
      scopeKeyByCheckout.set(scopedProjectKey(ref.environmentId, ref.projectId), scope.key);
    }
    chatScopes.push({ scope, chatKey });
  }
  if (chatScopes.length === 0) return NO_PROJECT_CHATS;
  const threadsByScope = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of input.threads) {
    const scopeKey = scopeKeyByCheckout.get(
      scopedProjectKey(thread.environmentId, thread.projectId),
    );
    if (scopeKey === undefined) continue;
    const list = threadsByScope.get(scopeKey);
    if (list) list.push(thread);
    else threadsByScope.set(scopeKey, [thread]);
  }
  for (const { scope, chatKey } of chatScopes) {
    const chat = shellByKey.get(chatKey)!;
    const counts = countProjectThreads(threadsByScope.get(scope.key) ?? [], chatKey);
    const entry: ProjectChat = {
      scopeKey: scope.key,
      title: scope.title,
      project: scope.representative,
      projectId: chat.projectId,
      chat,
      working: counts.working,
      statusLine: formatProjectStatusLine(counts),
    };
    byChatKey.set(chatKey, entry);
    byScopeKey.set(scope.key, entry);
    for (const ref of scope.projectRefs) {
      byCheckoutKey.set(scopedProjectKey(ref.environmentId, ref.projectId), entry);
    }
  }
  return { byChatKey, byScopeKey, byCheckoutKey };
}

/** What the chat's thread screen shows as the project; stable while the counts are unchanged. */
export interface ProjectChatHeader {
  readonly scopeKey: string;
  readonly title: string;
  readonly projectId: ProjectId;
  readonly working: number;
}

export function projectChatHeadersEqual(
  left: ProjectChatHeader | null,
  right: ProjectChatHeader | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.scopeKey === right.scopeKey &&
      left.title === right.title &&
      left.projectId === right.projectId &&
      left.working === right.working)
  );
}

/**
 * Where a `projects/<environmentId>/<projectId>` link goes: the project's chat, or the thread
 * list once it is clear the project has none. It waits while the saved connections load and the
 * machine's first connection is under way; a machine that is offline settles on its cache.
 */
export function resolveProjectLink(input: {
  readonly chat: ProjectChat | undefined;
  readonly catalogReady: boolean;
  /** null when this app has no saved connection to the machine. */
  readonly connection: EnvironmentConnectionPhase | null;
  readonly shellLive: boolean;
  readonly shellCacheRead: boolean;
}): "chat" | "list" | "wait" {
  if (input.chat !== undefined) return "chat";
  if (!input.catalogReady) return "wait";
  switch (input.connection) {
    case null:
      return "list";
    case "available":
    case "connecting":
      return "wait";
    case "connected":
      return input.shellLive ? "list" : "wait";
    case "reconnecting":
    case "offline":
    case "error":
    case "unsupported":
      return input.shellCacheRead ? "list" : "wait";
  }
}
