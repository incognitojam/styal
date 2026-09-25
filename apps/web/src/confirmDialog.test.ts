import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  acknowledgeConfirmDialogPresentation,
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  requestConfirmDialog,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "./confirmDialog";

function requireConfirmation(confirmation: Promise<boolean> | undefined): Promise<boolean> {
  if (!confirmation) {
    throw new Error("Expected a registered confirmation host.");
  }
  return confirmation;
}

describe("confirm dialog coordinator", () => {
  beforeEach(() => {
    resetConfirmDialogForTests();
  });

  it("returns undefined until a themed host is mounted", () => {
    expect(requestConfirmDialog("Confirm this action?")).toBeUndefined();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
  });

  it("resolves a displayed confirmation and waits for its close transition", async () => {
    const unregister = registerConfirmDialogHost();
    const confirmation = requireConfirmation(
      requestConfirmDialog("Delete this thread?", {
        variant: "destructive",
        confirmLabel: "Delete",
      }),
    );

    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      message: "Delete this thread?",
      variant: "destructive",
      confirmLabel: "Delete",
    });

    respondToConfirmDialog(true);
    await expect(confirmation).resolves.toBe(true);
    expect(readConfirmDialogState()).toEqual({
      status: "closing",
      message: "Delete this thread?",
      variant: "destructive",
      confirmLabel: "Delete",
    });

    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
  });

  it("serializes concurrent confirmations", async () => {
    const unregister = registerConfirmDialogHost();
    const first = requireConfirmation(requestConfirmDialog("Delete the project?"));
    const second = requireConfirmation(requestConfirmDialog("Delete the worktree too?"));

    respondToConfirmDialog(false);
    await expect(first).resolves.toBe(false);
    expect(readConfirmDialogState()).toEqual({
      status: "closing",
      message: "Delete the project?",
      variant: "default",
      confirmLabel: "Confirm",
    });

    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      message: "Delete the worktree too?",
      variant: "default",
      confirmLabel: "Confirm",
    });

    respondToConfirmDialog(true);
    await expect(second).resolves.toBe(true);
    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
  });

  it("cancels active and queued confirmations if the last host unmounts", async () => {
    const unregister = registerConfirmDialogHost();
    const active = requireConfirmation(requestConfirmDialog("Delete the thread?"));
    const queued = requireConfirmation(requestConfirmDialog("Delete the worktree too?"));

    unregister();

    await expect(Promise.all([active, queued])).resolves.toEqual([false, false]);
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
  });

  it("ignores responses after the active dialog has been closed", () => {
    const unregister = registerConfirmDialogHost();
    const confirmation = requireConfirmation(requestConfirmDialog("Continue?"));

    respondToConfirmDialog(true);
    respondToConfirmDialog(false);
    completeConfirmDialogClose();

    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
    return expect(confirmation).resolves.toBe(true);
  });
});

it("acknowledges only the committed active confirmation, never a queued request", async () => {
  resetConfirmDialogForTests();
  const unregister = registerConfirmDialogHost();
  let presented = 0;
  const first = requireConfirmation(requestConfirmDialog("Unrelated action?"));
  const second = requireConfirmation(
    requestConfirmDialog("Quit?", undefined, {
      onPresented: () => {
        presented++;
      },
    }),
  );
  acknowledgeConfirmDialogPresentation(readConfirmDialogState());
  expect(presented).toBe(0);
  respondToConfirmDialog(false);
  await first;
  completeConfirmDialogClose();
  expect(presented).toBe(0);
  const renderedState = readConfirmDialogState();
  acknowledgeConfirmDialogPresentation(renderedState);
  acknowledgeConfirmDialogPresentation(renderedState);
  expect(presented).toBe(1);
  respondToConfirmDialog(true);
  await expect(second).resolves.toBe(true);
  unregister();
});

it("removes expired queued shutdown requests without dismissing another dialog", async () => {
  resetConfirmDialogForTests();
  const unregister = registerConfirmDialogHost();
  const controller = new AbortController();
  let presented = false;
  const first = requireConfirmation(requestConfirmDialog("Unrelated action?"));
  const queued = requireConfirmation(
    requestConfirmDialog("Quit?", undefined, {
      signal: controller.signal,
      onPresented: () => {
        presented = true;
      },
    }),
  );
  controller.abort();
  await expect(queued).resolves.toBe(false);
  expect(readConfirmDialogState()).toMatchObject({
    status: "confirming",
    message: "Unrelated action?",
  });
  respondToConfirmDialog(false);
  await first;
  completeConfirmDialogClose();
  expect(readConfirmDialogState()).toEqual({ status: "idle" });
  expect(presented).toBe(false);
  unregister();
});

it("dismisses an expired active request and ignores a stale presentation effect", async () => {
  resetConfirmDialogForTests();
  const unregister = registerConfirmDialogHost();
  const controller = new AbortController();
  let presented = false;
  const request = requireConfirmation(
    requestConfirmDialog("Quit?", undefined, {
      signal: controller.signal,
      onPresented: () => {
        presented = true;
      },
    }),
  );
  const stale = readConfirmDialogState();
  controller.abort();
  acknowledgeConfirmDialogPresentation(stale);
  await expect(request).resolves.toBe(false);
  expect(presented).toBe(false);
  expect(readConfirmDialogState().status).toBe("closing");
  completeConfirmDialogClose();
  unregister();
});
