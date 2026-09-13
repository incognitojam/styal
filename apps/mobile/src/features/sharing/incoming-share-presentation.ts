export interface IncomingSharePresentationState {
  /** Share the layout last asked the new-task sheet to open. */
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

interface RouteLike {
  readonly name: string;
  readonly params?: object;
  readonly state?: { readonly routes: ReadonlyArray<RouteLike> };
}

function incomingShareIdOfParams(params: object | undefined): string | null {
  if (!params || !("incomingShareId" in params)) return null;
  const value = params.incomingShareId;
  const id = Array.isArray(value) ? value[0] : value;
  return typeof id === "string" ? id : null;
}

/**
 * The share id the new-task sheet is carrying, if the sheet is anywhere in the
 * root stack. Routes pushed above it (Add environment, a notification tap) do
 * not close it, so they must not read as a dismissal. Before the nested
 * navigator mounts, the id still sits in the `navigate` payload
 * (`params.params`); afterwards it lives on the nested route that owns it.
 */
export function incomingShareIdOfSheetRoute(
  state: { readonly routes: ReadonlyArray<RouteLike> },
  sheetRouteName: string,
): { readonly isSheetPresented: boolean; readonly shareId: string | null } {
  const sheet = state.routes.find((route) => route.name === sheetRouteName);
  if (!sheet) {
    return { isSheetPresented: false, shareId: null };
  }
  for (const route of sheet.state?.routes ?? []) {
    const shareId = incomingShareIdOfParams(route.params);
    if (shareId !== null) return { isSheetPresented: true, shareId };
  }
  const payload =
    sheet.params && "params" in sheet.params && typeof sheet.params.params === "object"
      ? (sheet.params.params as object | null)
      : null;
  return { isSheetPresented: true, shareId: incomingShareIdOfParams(payload ?? undefined) };
}

/**
 * Decides when the pending inbox share opens the new-task sheet and when the
 * user has walked away from it. A share counts as dismissed only after the
 * sheet was seen carrying it and then left the stack; until then a missing
 * sheet means the navigation never landed (container not ready, another route
 * won the race) and the request is simply repeated. Dismissal discards the share so that sharing
 * the same content again yields a fresh handoff instead of a silent no-op.
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

  if (state.presentedShareId === pendingShareId) {
    if (input.isSheetPresented) {
      if (input.sheetShareId === pendingShareId && !state.sheetSeen) {
        return { ...hold, state: { ...state, sheetSeen: true } };
      }
      return hold;
    }
    if (state.sheetSeen) {
      return {
        state: { presentedShareId: null, sheetSeen: false, discardedShareId: pendingShareId },
        shareIdToPresent: null,
        shareIdToDiscard: pendingShareId,
      };
    }
    return { ...hold, shareIdToPresent: pendingShareId };
  }

  if (input.isSheetPresented) {
    // Someone else owns the sheet (a manual new task, or the sheet of a share
    // that was just consumed). Wait for it to close.
    return {
      state: { presentedShareId: null, sheetSeen: false, discardedShareId: null },
      shareIdToPresent: null,
      shareIdToDiscard: null,
    };
  }

  return {
    state: { presentedShareId: pendingShareId, sheetSeen: false, discardedShareId: null },
    shareIdToPresent: pendingShareId,
    shareIdToDiscard: null,
  };
}
