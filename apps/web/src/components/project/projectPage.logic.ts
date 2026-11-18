import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  type EnvironmentId,
  isListedThreadLineage,
  projectCoordinatorThreadId,
  type ProjectId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";

import { resolveSidebarThreadStatus } from "../Sidebar.logic";

type CoordinatorSettings = Pick<
  ServerSettings,
  "projectCoordinatorsEnabled" | "projectCoordinators"
>;

interface ProjectCheckout {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
}

/** The checkout whose machine holds the project's chat, and the chat once it exists. */
export interface ProjectChatHost<Checkout extends ProjectCheckout = ProjectCheckout> {
  readonly checkout: Checkout;
  readonly chatThreadId: ThreadId | null;
}

/**
 * The project page needs project coordinators on in Labs on one of the project's machines. A
 * machine that already names a chat wins; otherwise the primary machine, then the first.
 */
export function resolveProjectChatHost<Checkout extends ProjectCheckout>(
  checkouts: ReadonlyArray<Checkout>,
  settingsFor: (environmentId: EnvironmentId) => CoordinatorSettings | undefined,
  primaryEnvironmentId: EnvironmentId | null,
  /** The project of a listed thread; null while it is not listed (it may not exist yet). */
  projectOfThread: (environmentId: EnvironmentId, threadId: ThreadId) => ProjectId | null,
): ProjectChatHost<Checkout> | null {
  let fallback: Checkout | null = null;
  for (const checkout of checkouts) {
    const settings = settingsFor(checkout.environmentId);
    if (settings?.projectCoordinatorsEnabled !== true) continue;
    const chatThreadId = projectCoordinatorThreadId(settings, checkout.id);
    // A named thread that turned out to belong to another project is not this project's chat.
    const chatProject =
      chatThreadId === null ? null : projectOfThread(checkout.environmentId, chatThreadId);
    if (chatThreadId !== null && (chatProject === null || chatProject === checkout.id)) {
      return { checkout, chatThreadId };
    }
    if (fallback === null || checkout.environmentId === primaryEnvironmentId) fallback = checkout;
  }
  return fallback === null ? null : { checkout: fallback, chatThreadId: null };
}

/**
 * Before the project is known, the route can only tell that every machine has the switch off;
 * null is a machine whose settings have not loaded, and the page decides once they have.
 */
export function projectPageRouteDisabled(
  settings: ReadonlyArray<CoordinatorSettings | null>,
): boolean {
  return (
    settings.length > 0 &&
    settings.every((entry) => entry !== null && !entry.projectCoordinatorsEnabled)
  );
}

export interface ProjectThreadCounts {
  readonly working: number;
  /** Waiting on an approval, a question or a report answer, as the sidebar's Approval and Input. */
  readonly needYou: number;
}

/** Counts a project's listed threads other than its chat; failed threads are not counted. */
export function countProjectThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  chatThreadKey: string | null,
): ProjectThreadCounts {
  let working = 0;
  let needYou = 0;
  for (const thread of threads) {
    if (thread.archivedAt != null || thread.deletedAt != null) continue;
    if (!isListedThreadLineage(thread.lineage)) continue;
    if (`${thread.environmentId}:${thread.id}` === chatThreadKey) continue;
    switch (resolveSidebarThreadStatus(thread)) {
      case "approval":
      case "input":
        needYou += 1;
        break;
      case "preparing":
      case "working":
        working += 1;
        break;
    }
  }
  return { working, needYou };
}

export function formatProjectStatusLine(counts: ProjectThreadCounts): string | null {
  const parts = [
    ...(counts.working > 0 ? [`${counts.working} working`] : []),
    ...(counts.needYou > 0 ? [`${counts.needYou} need${counts.needYou === 1 ? "s" : ""} you`] : []),
  ];
  return parts.length === 0 ? null : parts.join(" · ");
}

const PROJECT_CHAT_DRAFT_PREFIX = "project-chat-";

/**
 * One draft per checkout, so the page finds an unsent first message again. No colon: a stored
 * draft key with one is read back as `environmentId:threadId`.
 */
export function projectChatDraftId(checkout: ProjectCheckout): string {
  return `${PROJECT_CHAT_DRAFT_PREFIX}${encodeURIComponent(`${checkout.environmentId}/${checkout.id}`)}`;
}

/** The page owns this draft; listing it with the sidebar's drafts would send it as a plain thread. */
export function isProjectChatDraftId(draftId: string): boolean {
  return draftId.startsWith(PROJECT_CHAT_DRAFT_PREFIX);
}

interface ThreadRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/**
 * What the page shows for its chat. The stored chat wins over an unsent draft; a draft whose
 * message is sending stays until it finalizes. The page names the draft's thread as the chat
 * before sending it, so its first turn is told; `named` is that thread from when the server
 * lists it until the settings stream names it too.
 */
export function resolveProjectChatView(input: {
  readonly shellLive: boolean;
  readonly chat: ThreadRef | null;
  readonly draftOpen: boolean;
  readonly draftSending: boolean;
  readonly named: ThreadRef | null;
}): {
  readonly show:
    | { readonly kind: "draft" }
    | { readonly kind: "thread"; readonly ref: ThreadRef }
    | null;
  readonly openDraft: boolean;
} {
  if (input.draftOpen && (input.draftSending || input.chat === null)) {
    return { show: { kind: "draft" }, openDraft: false };
  }
  const shown = input.chat ?? input.named;
  if (shown !== null) return { show: { kind: "thread", ref: shown }, openDraft: false };
  return { show: null, openDraft: input.shellLive && !input.draftOpen };
}
