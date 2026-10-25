import { isDraftThreadRoute } from "../threads/thread-route-state";

export interface IncomingSharePresentationState {
  /** Share the layout last asked the new-task draft to open. */
  readonly presentedShareId: string | null;
  /** Whether the sheet was actually observed carrying `presentedShareId`. */
  readonly sheetSeen: boolean;
  /** Share the user closed the sheet on; ignored until the inbox drops it. */
  readonly discardedShareId: string | null;
}

export interface IncomingSharePresentationTransition {
  readonly state: IncomingSharePresentationState;
  readonly shareIdToPresent: string | null;
  readonly shareIdToDiscard: string | null;
}

export const EMPTY_INCOMING_SHARE_PRESENTATION_STATE: IncomingSharePresentationState = {
  presentedShareId: null,
  sheetSeen: false,
  discardedShareId: null,
};

const NEW_TASK_PROJECT_ROUTE = "NewTaskProject";

interface RouteLike {
  readonly name: string;
  readonly params?: object;
}

function incomingShareIdOfParams(params: object | undefined): string | null {
  if (!params || !("incomingShareId" in params)) return null;
  const value = params.incomingShareId;
  const id = Array.isArray(value) ? value[0] : value;
  return typeof id === "string" ? id : null;
}

/**
 * Routes pushed above a draft or the project picker do not close the new-task flow, so they must
 * not read as a dismissal. Sending a draft leaves the picker behind, so a picker below a live
 * thread belongs to a finished flow; a draft below one is still open.
 */
export function incomingShareIdOfNewTaskRoutes(state: {
  readonly routes: ReadonlyArray<RouteLike>;
}): { readonly isSheetPresented: boolean; readonly shareId: string | null } {
  let isSheetPresented = false;
  let belowLiveThread = false;
  for (let index = state.routes.length - 1; index >= 0; index -= 1) {
    const route = state.routes[index]!;
    const isDraft = isDraftThreadRoute(route);
    if (route.name === "Thread" && !isDraft) {
      belowLiveThread = true;
      continue;
    }
    const params = isDraft
      ? (route.params as { readonly draft?: object } | undefined)?.draft
      : route.name === NEW_TASK_PROJECT_ROUTE && !belowLiveThread
        ? route.params
        : null;
    if (params === null) continue;
    isSheetPresented = true;
    const shareId = incomingShareIdOfParams(params);
    if (shareId !== null) return { isSheetPresented, shareId };
  }
  return { isSheetPresented, shareId: null };
}

/**
 * A share is dismissed only after its sheet was seen and then left the stack; before that a
 * missing sheet means navigation never landed, so the request repeats. Dismissal discards the
 * share so sharing the same content again starts fresh. A tracked share outlives a newer pending
 * one so closing its sheet discards it instead of letting it resurface.
 */
export function transitionIncomingSharePresentation(
  state: IncomingSharePresentationState,
  input: {
    readonly isSheetPresented: boolean;
    readonly sheetShareId: string | null;
    readonly pendingShareId: string | null;
  },
): IncomingSharePresentationTransition {
  const hold = { state, shareIdToPresent: null, shareIdToDiscard: null };
  const { pendingShareId } = input;

  if (pendingShareId === null) {
    return {
      state: EMPTY_INCOMING_SHARE_PRESENTATION_STATE,
      shareIdToPresent: null,
      shareIdToDiscard: null,
    };
  }

  if (state.discardedShareId === pendingShareId) {
    // The inbox has not caught up with the discard yet.
    return hold;
  }

  const tracked = state.presentedShareId;
  if (input.isSheetPresented) {
    if (tracked === null) {
      // A sheet nobody here asked for (a manual new task). Wait for it to close.
      return { ...hold, state: EMPTY_INCOMING_SHARE_PRESENTATION_STATE };
    }
    if (input.sheetShareId === tracked && !state.sheetSeen) {
      return { ...hold, state: { ...state, sheetSeen: true } };
    }
    return hold;
  }

  // The sheet is gone. A tracked share that was seen is dismissed; anything
  // else is a request that never landed and is repeated. A consumed share can
  // also land here (its sheet closed onto the thread); discarding it again is
  // a no-op since the inbox no longer has it.
  const shareIdToDiscard = tracked !== null && state.sheetSeen ? tracked : null;
  const shareIdToPresent = shareIdToDiscard === pendingShareId ? null : pendingShareId;
  return {
    state: {
      presentedShareId: shareIdToPresent,
      sheetSeen: false,
      discardedShareId: shareIdToDiscard,
    },
    shareIdToPresent,
    shareIdToDiscard,
  };
}
