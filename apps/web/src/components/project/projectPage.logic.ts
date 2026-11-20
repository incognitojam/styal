import type { ProjectCheckout } from "@t3tools/client-runtime/project-page";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { resolveThreadListStatus } from "@t3tools/client-runtime/state/thread-list-status";
import {
  type EnvironmentId,
  type ProjectId,
  projectCoordinatorThreadId,
  type ScheduledTaskThread,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";

type CoordinatorSettings = Pick<
  ServerSettings,
  "projectCoordinatorsEnabled" | "projectCoordinators"
>;

/**
 * The project whose page a thread's address opens instead: the thread is its project's coordinator
 * on its machine, with project coordinators on there, the project has a page (not Scratch or
 * archived), and every other machine of the project has loaded its settings and names no chat the
 * page could show instead.
 */
export function coordinatedProjectKey(
  thread: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
  },
  settingsFor: (environmentId: EnvironmentId) => CoordinatorSettings | undefined,
  groupOf: (
    environmentId: EnvironmentId,
    projectId: ProjectId,
  ) => {
    readonly projectKey: string;
    readonly isScratch?: boolean | undefined;
    readonly archived?: boolean | undefined;
    readonly memberProjects: ReadonlyArray<ProjectCheckout>;
  } | null,
): string | null {
  const settings = settingsFor(thread.environmentId);
  if (!settings || projectCoordinatorThreadId(settings, thread.projectId) !== thread.threadId) {
    return null;
  }
  const group = groupOf(thread.environmentId, thread.projectId);
  if (!group || group.isScratch || group.archived) return null;
  const otherChat = group.memberProjects.some((member) => {
    if (member.environmentId === thread.environmentId && member.id === thread.projectId) {
      return false;
    }
    // Settings not loaded yet may name a chat the page would show instead.
    const memberSettings = settingsFor(member.environmentId);
    return (
      memberSettings === undefined || projectCoordinatorThreadId(memberSettings, member.id) !== null
    );
  });
  return otherChat ? null : group.projectKey;
}

/**
 * Whether a project chat still hears from the threads it started, as the server decides for a
 * launcher: not archived, deleted, or settled by the user.
 */
export function projectChatTakesReports(chat: {
  readonly archivedAt: unknown;
  readonly deletedAt?: unknown;
  readonly settledOverride?: string | null;
  readonly settleReason?: { readonly kind: string } | null | undefined;
}): boolean {
  return (
    chat.archivedAt == null &&
    chat.deletedAt == null &&
    !(chat.settledOverride === "settled" && chat.settleReason?.kind === "user")
  );
}

/**
 * Whether a task runs in its thread again: a paused task, one a policy blocks, or a one-time task
 * that has run leaves its thread in the sidebar.
 */
export function jobRunsAgain(task: ScheduledTaskThread): boolean {
  return (
    task.enabled &&
    task.blockedByPolicy === undefined &&
    (task.schedule.type === "webhook" ||
      task.nextRunAt !== null ||
      task.lastRunStatus === "running")
  );
}

/**
 * By thread id, for the threads tasks that run again are bound to: when its tasks' latest run
 * began, or before any has run, when the latest task was made. Only what the person writes after
 * that brings the thread back to the sidebar.
 */
export function jobThreadsSince(
  tasks: ReadonlyArray<ScheduledTaskThread>,
): ReadonlyMap<ThreadId, number> {
  const since = new Map<ThreadId, number>();
  for (const task of tasks) {
    if (!jobRunsAgain(task)) continue;
    const at = Date.parse(task.lastRunAt ?? task.createdAt);
    since.set(task.threadId, Math.max(at, since.get(task.threadId) ?? at));
  }
  return since;
}

/**
 * Whether a scheduled task's thread is one its project page keeps: it is in `jobsSince`
 * (`jobThreadsSince` of its machine), it is not its project's chat, and the project has a page
 * (not Scratch or archived).
 */
export function isProjectPageJob(
  thread: { readonly id: ThreadId; readonly projectId: ProjectId },
  jobsSince: ReadonlyMap<ThreadId, number>,
  settings: CoordinatorSettings | undefined,
  group: { readonly isScratch?: boolean | undefined; readonly archived: boolean } | undefined,
): boolean {
  return (
    jobsSince.has(thread.id) &&
    settings !== undefined &&
    projectCoordinatorThreadId(settings, thread.projectId) !== thread.id &&
    group !== undefined &&
    group.isScratch !== true &&
    !group.archived
  );
}

const NO_JOB_THREADS: ReadonlyMap<string, number> = new Map();

/**
 * A thread the project's chat launched with reportBack, or a scheduled task's thread in
 * `jobsSince` (by thread key), stays on the project page until it needs you, fails, is pinned or
 * you write to it (to a job, after its `jobsSince` time). A `project-coordinator` report target
 * only says the thread was created in the project. `chatThreadKeys`: chats taking reports.
 */
export function staysOnProjectPage(
  thread: EnvironmentThreadShell,
  chatThreadKeys: ReadonlySet<string>,
  jobsSince: ReadonlyMap<string, number> = NO_JOB_THREADS,
): boolean {
  const launched =
    thread.reportTo != null &&
    thread.reportTo.source === undefined &&
    chatThreadKeys.has(`${thread.environmentId}:${thread.reportTo.threadId}`) &&
    thread.source.createdBy === "agent";
  const jobSince = jobsSince.get(`${thread.environmentId}:${thread.id}`);
  const authored = thread.latestUserAuthoredMessageAt;
  if (
    !(launched || jobSince !== undefined) ||
    thread.pinnedAt != null ||
    (authored != null && (jobSince === undefined || Date.parse(authored) > jobSince)) ||
    thread.latestRun?.status === "failed"
  )
    return false;
  switch (resolveThreadListStatus(thread)) {
    case "approval":
    case "input":
    case "request":
    case "failed":
    case "limited":
      return false;
    default:
      return true;
  }
}

const PROJECT_CHAT_DRAFT_PREFIX = "project-chat-";

/**
 * One draft per project, whichever machine it is on, so the page finds an unsent first message
 * again. No colon: a stored draft key with one is read back as `environmentId:threadId`.
 */
export function projectChatDraftId(projectKey: string): string {
  return `${PROJECT_CHAT_DRAFT_PREFIX}${encodeURIComponent(projectKey)}`;
}

/** The id a project chat draft had when drafts were kept per checkout; an unsent one is still used. */
export function legacyProjectChatDraftId(checkout: ProjectCheckout): string {
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
