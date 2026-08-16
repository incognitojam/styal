import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";
import type { DraftThreadEnvMode } from "../composerDraftStore";

interface ThreadContextLike {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}

/** The sidebar project filter's target, as much of it as resolution needs. */
interface ProjectScopeGroupLike {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly memberProjectRefs: readonly ScopedProjectRef[];
}

interface NewThreadHandler {
  (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
    },
    // The opened draft's identity, which most callers have no use for.
  ): Promise<unknown>;
}

export interface ChatThreadActionContext {
  readonly activeDraftThread: ThreadContextLike | null;
  readonly activeThread: ThreadContextLike | undefined;
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly handleNewThread: NewThreadHandler;
  /** The sidebar's project filter, when one is applied. */
  readonly scopedProjectGroup?: ProjectScopeGroupLike | null;
}

export function resolveNewDraftStartFromOrigin(input: {
  envMode: DraftThreadEnvMode;
  newWorktreesStartFromOrigin: boolean;
}): boolean {
  return input.envMode === "worktree" && input.newWorktreesStartFromOrigin;
}

/**
 * Which affordance is asking, because the sidebar's project filter outranks
 * different things for each.
 *
 * `"sidebar"` is the new thread button inside the filtered list: the filter
 * beats the thread you are viewing, so the new draft always appears in the
 * list you are looking at.
 *
 * `"contextual"` is chat.newLocal and its command palette twin — "start
 * another one right here". The thread you are viewing beats the filter, or
 * there would be no way to open a thread beside your current work while the
 * sidebar is narrowed elsewhere. The filter still beats the fallback default,
 * so with nothing open these land in the project on screen.
 */
export type NewThreadOrigin = "sidebar" | "contextual";

/** The project you are looking at, ignoring both filter and fallback. */
function resolveContextualProjectRef(context: ChatThreadActionContext): ScopedProjectRef | null {
  if (context.activeThread) {
    return scopeProjectRef(context.activeThread.environmentId, context.activeThread.projectId);
  }
  if (context.activeDraftThread) {
    return scopeProjectRef(
      context.activeDraftThread.environmentId,
      context.activeDraftThread.projectId,
    );
  }
  return null;
}

/** The filtered project, holding the member you are already in when the group
    spans environments so the same project local and remote does not snap back
    to its representative. */
function resolveScopedProjectRef(context: ChatThreadActionContext): ScopedProjectRef | null {
  const scopedProjectGroup = context.scopedProjectGroup ?? null;
  if (scopedProjectGroup === null) return null;
  const contextualProjectRef = resolveContextualProjectRef(context);
  const isContextualRefInScope =
    contextualProjectRef !== null &&
    scopedProjectGroup.memberProjectRefs.some(
      (projectRef) =>
        projectRef.environmentId === contextualProjectRef.environmentId &&
        projectRef.projectId === contextualProjectRef.projectId,
    );
  return isContextualRefInScope
    ? contextualProjectRef
    : scopeProjectRef(scopedProjectGroup.environmentId, scopedProjectGroup.id);
}

export function resolveThreadActionProjectRef(
  context: ChatThreadActionContext,
  origin: NewThreadOrigin = "contextual",
): ScopedProjectRef | null {
  const scopedProjectRef = resolveScopedProjectRef(context);
  if (origin === "sidebar" && scopedProjectRef !== null) {
    return scopedProjectRef;
  }
  return resolveContextualProjectRef(context) ?? scopedProjectRef ?? context.defaultProjectRef;
}

/**
 * Whether the sidebar button and the contextual commands land in the same
 * project. They part ways only when the filter names a project other than the
 * one you are viewing; that is the case where the button has no keyboard twin
 * and its tooltip must not claim one.
 */
export function newThreadOriginsAgree(context: ChatThreadActionContext): boolean {
  const sidebarProjectRef = resolveThreadActionProjectRef(context, "sidebar");
  const contextualProjectRef = resolveThreadActionProjectRef(context, "contextual");
  if (sidebarProjectRef === null || contextualProjectRef === null) {
    return sidebarProjectRef === contextualProjectRef;
  }
  return (
    sidebarProjectRef.environmentId === contextualProjectRef.environmentId &&
    sidebarProjectRef.projectId === contextualProjectRef.projectId
  );
}

// New threads inherit only the *project* from the current context. Branch,
// worktree, and env mode always come from the user's configured defaults —
// carrying them over from the viewed thread meant "new thread" silently
// reused checkouts and branches. Explicit affordances (branch toolbar's
// "new thread in this worktree") pass those options to handleNewThread
// directly instead.
export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
  origin: NewThreadOrigin = "contextual",
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context, origin);
  if (!projectRef) {
    return false;
  }

  await context.handleNewThread(projectRef);
  return true;
}
