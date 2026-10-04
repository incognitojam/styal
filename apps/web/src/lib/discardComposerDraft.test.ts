import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { toastManager } from "../components/ui/toast";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useThreadUndoNotice } from "../hooks/showThreadUndoNotice";
import * as ComposerDrafts from "../state/composerDrafts";
import { releaseDraftAttachments } from "./attachmentUploadQueue";
import { discardComposerDraft } from "./discardComposerDraft";

vi.mock("./attachmentUploadQueue", () => ({ releaseDraftAttachments: vi.fn() }));

const environmentId = EnvironmentId.make("environment-local");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-1"));
const draftId = DraftId.make("draft-1");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-1"));

function undoNotice() {
  const notice = useThreadUndoNotice.getState().notice;
  if (!notice) throw new Error("Undo notice is missing");
  return notice;
}

beforeEach(() => {
  vi.useFakeTimers();
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
});
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("discardComposerDraft", () => {
  it("clears the synchronized copy of a closed thread's draft", async () => {
    let remoteText = "reply in progress";
    useComposerDraftStore.getState().setPrompt(threadRef, remoteText);
    vi.spyOn(ComposerDrafts, "discardServerComposerDraft").mockImplementation(async (ref) => {
      remoteText = useComposerDraftStore.getState().getComposerDraft(ref)?.prompt ?? "";
    });

    discardComposerDraft(threadRef);
    expect(remoteText).toBe("");
    vi.advanceTimersByTime(5_000);
    expect(remoteText).toBe("");
  });

  it("restores the synchronized draft after an in-flight discard finishes", async () => {
    let remoteText = "reply in progress";
    let finishClear = () => {};
    const clearFinished = new Promise<void>((resolve) => {
      finishClear = resolve;
    });
    useComposerDraftStore.getState().setPrompt(threadRef, remoteText);
    vi.spyOn(ComposerDrafts, "discardServerComposerDraft")
      .mockImplementationOnce(async () => {
        await clearFinished;
        remoteText = "";
      })
      .mockImplementationOnce(async (ref) => {
        remoteText = useComposerDraftStore.getState().getComposerDraft(ref)?.prompt ?? "";
      });

    discardComposerDraft(threadRef);
    const restored = undoNotice().undo();
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
      "reply in progress",
    );
    finishClear();
    await restored;
    expect(remoteText).toBe("reply in progress");
    vi.runAllTimers();
    expect(releaseDraftAttachments).not.toHaveBeenCalled();
  });

  it("restores a discarded new-thread draft with its project mapping", async () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId);
    store.setPrompt(draftId, "half-written prompt");
    const before = useComposerDraftStore.getState();

    discardComposerDraft(draftId);
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBeNull();
    expect(undoNotice()).toMatchObject({ action: "Discarded", count: 1 });

    await undoNotice().undo();
    const after = useComposerDraftStore.getState();
    expect(after.getDraftSession(draftId)).toEqual(before.getDraftSession(draftId));
    expect(after.getComposerDraft(draftId)?.prompt).toBe("half-written prompt");
    expect(after.logicalProjectDraftThreadKeyByLogicalProjectKey).toEqual(
      before.logicalProjectDraftThreadKeyByLogicalProjectKey,
    );
    vi.runAllTimers();
    expect(releaseDraftAttachments).not.toHaveBeenCalled();
  });

  it("clears a thread draft for good and releases its uploads once undo expires", async () => {
    useComposerDraftStore.getState().setPrompt(threadRef, "reply in progress");

    discardComposerDraft(threadRef);
    const notice = undoNotice();
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt ?? "").toBe("");
    expect(releaseDraftAttachments).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_000);
    expect(useThreadUndoNotice.getState().notice).toBeNull();
    expect(releaseDraftAttachments).toHaveBeenCalledOnce();
    await notice.undo();
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt ?? "").toBe("");
  });

  it("keeps text typed after the discard and releases the old uploads", async () => {
    useComposerDraftStore.getState().setPrompt(threadRef, "old reply");
    discardComposerDraft(threadRef);
    useComposerDraftStore.getState().setPrompt(threadRef, "new reply");
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("error-toast");

    await undoNotice().undo();
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe("new reply");
    expect(releaseDraftAttachments).toHaveBeenCalledOnce();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to restore draft" }),
    );
  });
});
