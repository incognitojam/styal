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
  return context.defaultProjectRef;
}

export function resolveThreadActionProjectRef(
  context: ChatThreadActionContext,
): ScopedProjectRef | null {
  const contextualProjectRef = resolveContextualProjectRef(context);
  const scopedProjectGroup = context.scopedProjectGroup ?? null;
  if (scopedProjectGroup === null) {
    return contextualProjectRef;
  }
  // A project filter outranks the thread being viewed: filtering is the later
  // and more deliberate choice, and a list showing one project that spawns
  // threads elsewhere is a lie. Within the filtered group the contextual
  // member still wins, so a group spanning environments (the same project
  // local and remote) does not snap back to its representative.
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

// New threads inherit only the *project* from the current context. Branch,
// worktree, and env mode always come from the user's configured defaults —
// carrying them over from the viewed thread meant "new thread" silently
// reused checkouts and branches. Explicit affordances (branch toolbar's
// "new thread in this worktree") pass those options to handleNewThread
// directly instead.
export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  await context.handleNewThread(projectRef);
  return true;
}
