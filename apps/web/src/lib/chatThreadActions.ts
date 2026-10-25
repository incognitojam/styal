import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ScopedProjectRef,
} from "@t3tools/contracts";
import type { ComposerThreadDraftState, DraftThreadEnvMode } from "../composerDraftStore";
import { reportNewThreadWhileFiltered } from "../sidebarProjectFilterUsage";

type ComposerModelSelectionState = Pick<
  ComposerThreadDraftState,
  "activeProvider" | "modelSelectionByProvider" | "modelSelectionExplicit"
>;

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

export function resolveNewThreadModelSelectionOverride(input: {
  readonly projectDefaultSelection: ModelSelection | null;
  readonly carrySelection: ModelSelection | null;
  readonly carrySourceDraftId: string | null;
  readonly destinationDraftId: string;
}): ModelSelection | null {
  return (
    input.projectDefaultSelection ??
    (input.carrySourceDraftId === input.destinationDraftId ? null : input.carrySelection)
  );
}

export function hasExplicitComposerModelSelection(
  draft: ComposerModelSelectionState | null | undefined,
): boolean {
  const activeProvider = draft?.activeProvider;
  return (
    draft?.modelSelectionExplicit === true &&
    activeProvider !== null &&
    activeProvider !== undefined &&
    draft.modelSelectionByProvider[activeProvider] !== undefined
  );
}

/**
 * `"sidebar"`: the project filter beats the viewed thread, so the draft appears in the visible list.
 * `"contextual"` (chat.newLocal): the viewed thread beats the filter, so a thread can open beside
 * current work while the sidebar is narrowed elsewhere; the filter still beats the fallback default.
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

export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
  origin: NewThreadOrigin = "contextual",
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context, origin);
  if (!projectRef) {
    return false;
  }

  await context.handleNewThread(projectRef);
  void reportNewThreadWhileFiltered();
  return true;
}
