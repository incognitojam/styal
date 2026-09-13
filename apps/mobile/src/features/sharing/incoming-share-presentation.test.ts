import { describe, expect, it } from "@effect/vitest";

import {
  EMPTY_INCOMING_SHARE_PRESENTATION_STATE,
  incomingShareIdOfTopRoute,
  transitionIncomingSharePresentation,
  type IncomingSharePresentationState,
} from "./incoming-share-presentation";

const closed = { isSheetOnTop: false, sheetShareId: null };
const sheetWith = (shareId: string | null) => ({ isSheetOnTop: true, sheetShareId: shareId });

function present(shareId: string, state = EMPTY_INCOMING_SHARE_PRESENTATION_STATE) {
  const transition = transitionIncomingSharePresentation(state, {
    ...closed,
    pendingShareId: shareId,
  });
  expect(transition.shareIdToPresent).toBe(shareId);
  return transition.state;
}

function seen(shareId: string, state: IncomingSharePresentationState) {
  const transition = transitionIncomingSharePresentation(state, {
    ...sheetWith(shareId),
    pendingShareId: shareId,
  });
  expect(transition.shareIdToPresent).toBeNull();
  expect(transition.state.sheetSeen).toBe(true);
  return transition.state;
}

describe("transitionIncomingSharePresentation", () => {
  it("re-requests the sheet when the first navigation never landed", () => {
    const requested = present("share-1");
    const retry = transitionIncomingSharePresentation(requested, {
      ...closed,
      pendingShareId: "share-1",
    });
    expect(retry.shareIdToPresent).toBe("share-1");
    expect(retry.shareIdToDiscard).toBeNull();
  });

  it("does not count a sheet that carries no share id as the share being seen", () => {
    const requested = present("share-1");
    const manualSheet = transitionIncomingSharePresentation(requested, {
      ...sheetWith(null),
      pendingShareId: "share-1",
    });
    expect(manualSheet.state.sheetSeen).toBe(false);
    const closedAgain = transitionIncomingSharePresentation(manualSheet.state, {
      ...closed,
      pendingShareId: "share-1",
    });
    expect(closedAgain.shareIdToPresent).toBe("share-1");
    expect(closedAgain.shareIdToDiscard).toBeNull();
  });

  it("discards the share once its sheet was seen and then closed", () => {
    const state = seen("share-1", present("share-1"));
    const dismissed = transitionIncomingSharePresentation(state, {
      ...closed,
      pendingShareId: "share-1",
    });
    expect(dismissed.shareIdToDiscard).toBe("share-1");
    expect(dismissed.shareIdToPresent).toBeNull();

    // The inbox still reports it until the discard lands; hold, do not reopen.
    const held = transitionIncomingSharePresentation(dismissed.state, {
      ...closed,
      pendingShareId: "share-1",
    });
    expect(held).toEqual({
      state: dismissed.state,
      shareIdToPresent: null,
      shareIdToDiscard: null,
    });

    // Once dropped, the same id (re-sharing identical content) is a fresh handoff.
    const empty = transitionIncomingSharePresentation(held.state, {
      ...closed,
      pendingShareId: null,
    });
    expect(empty.state).toEqual(EMPTY_INCOMING_SHARE_PRESENTATION_STATE);
    expect(present("share-1", empty.state).presentedShareId).toBe("share-1");
  });

  it("presents the next queued share after the previous one is consumed", () => {
    const state = seen("share-1", present("share-1"));
    const consumedWhileOpen = transitionIncomingSharePresentation(state, {
      ...sheetWith("share-1"),
      pendingShareId: "share-2",
    });
    expect(consumedWhileOpen.shareIdToPresent).toBeNull();
    expect(consumedWhileOpen.shareIdToDiscard).toBeNull();

    const next = transitionIncomingSharePresentation(consumedWhileOpen.state, {
      ...closed,
      pendingShareId: "share-2",
    });
    expect(next.shareIdToPresent).toBe("share-2");
  });

  it("clears everything when the inbox empties", () => {
    const state = seen("share-1", present("share-1"));
    expect(
      transitionIncomingSharePresentation(state, { ...sheetWith("share-1"), pendingShareId: null })
        .state,
    ).toEqual(EMPTY_INCOMING_SHARE_PRESENTATION_STATE);
  });
});

describe("incomingShareIdOfTopRoute", () => {
  it("reads the id from the navigate payload before the nested navigator mounts", () => {
    expect(
      incomingShareIdOfTopRoute(
        {
          index: 1,
          routes: [
            { name: "Home" },
            {
              name: "NewTaskSheet",
              params: { screen: "NewTask", params: { incomingShareId: "share-1" } },
            },
          ],
        },
        "NewTaskSheet",
      ),
    ).toEqual({ isSheetOnTop: true, shareId: "share-1" });
  });

  it("reads the id from the nested route once mounted, including the draft screen", () => {
    expect(
      incomingShareIdOfTopRoute(
        {
          index: 1,
          routes: [
            { name: "Home" },
            {
              name: "NewTaskSheet",
              state: {
                routes: [
                  { name: "NewTask", params: { incomingShareId: "share-1" } },
                  { name: "NewTaskDraft", params: { incomingShareId: "share-1" } },
                ],
              },
            },
          ],
        },
        "NewTaskSheet",
      ),
    ).toEqual({ isSheetOnTop: true, shareId: "share-1" });
  });

  it("reports a manual new task sheet without a share id", () => {
    expect(
      incomingShareIdOfTopRoute(
        {
          index: 1,
          routes: [
            { name: "Home" },
            { name: "NewTaskSheet", state: { routes: [{ name: "NewTask", params: {} }] } },
          ],
        },
        "NewTaskSheet",
      ),
    ).toEqual({ isSheetOnTop: true, shareId: null });
  });

  it("reports other top routes as not the sheet", () => {
    expect(
      incomingShareIdOfTopRoute(
        { index: 1, routes: [{ name: "NewTaskSheet" }, { name: "SettingsSheet" }] },
        "NewTaskSheet",
      ),
    ).toEqual({ isSheetOnTop: false, shareId: null });
  });
});
