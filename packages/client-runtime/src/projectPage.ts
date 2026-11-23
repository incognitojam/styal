import {
  isListedThreadLineage,
  projectCoordinatorThreadId,
  type EnvironmentId,
  type ProjectId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./state/models.ts";
import { resolveThreadListStatus } from "./state/threadListStatus.ts";

type CoordinatorSettings = Pick<
  ServerSettings,
  "projectCoordinatorsEnabled" | "projectCoordinators"
>;

export interface ProjectCheckout {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
}

/** The checkout whose machine holds the project's chat, and the chat once it exists. */
export interface ProjectChatHost<Checkout extends ProjectCheckout = ProjectCheckout> {
  readonly checkout: Checkout;
  readonly chatThreadId: ThreadId | null;
  /** Until the chat exists: the checkouts it can be started on, the default among them. */
  readonly choices: ReadonlyArray<Checkout>;
  /** Until the chat exists: checkouts on machines with project coordinators off. */
  readonly off: ReadonlyArray<Checkout>;
}

/** What ranks the project's checkouts when picking the chat's machine. */
export interface ProjectChatHostRanking<Checkout extends ProjectCheckout> {
  /** The latest activity among the checkout's threads, in epoch milliseconds. */
  readonly checkoutActivityAt: (checkout: Checkout) => number;
  /** A named chat's own latest activity, in epoch milliseconds; -Infinity while not listed. */
  readonly chatActivityAt: (environmentId: EnvironmentId, threadId: ThreadId) => number;
  readonly connected: (environmentId: EnvironmentId) => boolean;
}

/**
 * The project page needs project coordinators on in Labs on one of the project's machines. A
 * machine that names a chat wins; if several do, the chat active most recently. A new chat
 * defaults to a connected checkout, the one where the project was last active, then the primary
 * machine's, then the first.
 */
export function resolveProjectChatHost<Checkout extends ProjectCheckout>(
  checkouts: ReadonlyArray<Checkout>,
  settingsFor: (environmentId: EnvironmentId) => CoordinatorSettings | undefined,
  primaryEnvironmentId: EnvironmentId | null,
  /** The project of a listed thread; null while it is not listed (it may not exist yet). */
  projectOfThread: (environmentId: EnvironmentId, threadId: ThreadId) => ProjectId | null,
  ranking: ProjectChatHostRanking<Checkout>,
): ProjectChatHost<Checkout> | null {
  const choices: Checkout[] = [];
  const off: Checkout[] = [];
  let chat: {
    readonly checkout: Checkout;
    readonly threadId: ThreadId;
    readonly at: number;
  } | null = null;
  for (const checkout of checkouts) {
    const settings = settingsFor(checkout.environmentId);
    if (settings?.projectCoordinatorsEnabled !== true) {
      if (settings !== undefined) off.push(checkout);
      continue;
    }
    const chatThreadId = projectCoordinatorThreadId(settings, checkout.id);
    // A named thread that turned out to belong to another project is not this project's chat.
    const chatProject =
      chatThreadId === null ? null : projectOfThread(checkout.environmentId, chatThreadId);
    if (chatThreadId !== null && (chatProject === null || chatProject === checkout.id)) {
      const at = ranking.chatActivityAt(checkout.environmentId, chatThreadId);
      if (chat === null || at > chat.at) chat = { checkout, threadId: chatThreadId, at };
      continue;
    }
    choices.push(checkout);
  }
  if (chat !== null) {
    return { checkout: chat.checkout, chatThreadId: chat.threadId, choices: [], off: [] };
  }
  const rank = (checkout: Checkout) => [
    ranking.connected(checkout.environmentId) ? 1 : 0,
    ranking.checkoutActivityAt(checkout),
    checkout.environmentId === primaryEnvironmentId ? 1 : 0,
  ];
  let best: Checkout | null = null;
  for (const checkout of choices) {
    if (best === null) {
      best = checkout;
      continue;
    }
    const next = rank(checkout);
    const current = rank(best);
    const first = next.findIndex((value, index) => value !== current[index]);
    if (first !== -1 && next[first]! > current[first]!) best = checkout;
  }
  return best === null ? null : { checkout: best, chatThreadId: null, choices, off };
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
  /** Waiting on an approval, a question or a report answer, as a thread row's Approval and Input. */
  readonly needYou: ReadonlyArray<EnvironmentThreadShell>;
  /** Stopped by a failure or a usage limit, as a thread row's Failed and Limited. */
  readonly stopped: ReadonlyArray<EnvironmentThreadShell>;
}

/** Counts a project's listed threads other than its chat; failed threads are not counted. */
export function countProjectThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  chatThreadKey: string | null,
): ProjectThreadCounts {
  let working = 0;
  const needYou: EnvironmentThreadShell[] = [];
  const stopped: EnvironmentThreadShell[] = [];
  for (const thread of threads) {
    if (thread.archivedAt != null || thread.deletedAt != null) continue;
    if (!isListedThreadLineage(thread.lineage)) continue;
    if (`${thread.environmentId}:${thread.id}` === chatThreadKey) continue;
    switch (resolveThreadListStatus(thread)) {
      case "approval":
      case "input":
        needYou.push(thread);
        break;
      case "preparing":
      case "working":
        working += 1;
        break;
      case "failed":
      case "limited":
        stopped.push(thread);
        break;
    }
  }
  return { working, needYou, stopped };
}

export function formatProjectStatusLine(
  counts: Pick<ProjectThreadCounts, "working" | "needYou">,
): string | null {
  const needYou = counts.needYou.length;
  const parts = [
    ...(counts.working > 0 ? [`${counts.working} working`] : []),
    ...(needYou > 0 ? [`${needYou} need${needYou === 1 ? "s" : ""} you`] : []),
  ];
  return parts.length === 0 ? null : parts.join(" · ");
}
