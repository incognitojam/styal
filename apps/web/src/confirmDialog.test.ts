import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ThreadId, type ConfirmDialogThreadActivity } from "@t3tools/contracts";

import {
  acknowledgeConfirmDialogPresentation,
  completeConfirmDialogClose,
  confirmActiveConfirmDialog,
  readConfirmDialogState,
  requestConfirmDialog,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
  isConfirmDialogActive,
  subscribeConfirmDialogHost,
} from "./confirmDialog";

const mountHost = () => subscribeConfirmDialogHost(() => {});

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

  it("resolves a displayed confirmation and waits for its close transition", async () => {
    const unregister = mountHost();
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
    expect(isConfirmDialogActive()).toBe(true);
    expect(readConfirmDialogState()).toEqual({
      status: "closing",
      message: "Delete this thread?",
      variant: "destructive",
      confirmLabel: "Delete",
    });

    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    expect(isConfirmDialogActive()).toBe(false);
    unregister();
  });

  it("serializes concurrent confirmations", async () => {
    const unregister = mountHost();
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

  it("keeps queued thread details with their dialog through dismissal, then clears them", async () => {
    const unregister = mountHost();
    const first = requireConfirmation(requestConfirmDialog("Delete the project?"));
    const threadActivity: ReadonlyArray<ConfirmDialogThreadActivity> = [
      {
        thread: {
          threadId: ThreadId.make("preview"),
          title: "Watch the preview build",
          reasons: ["monitor"],
          continuable: true,
        },
        hostLabel: "Lab server",
        continuesAfterRestart: true,
      },
    ];
    const restart = requireConfirmation(requestConfirmDialog("Restart styal?", { threadActivity }));
    expect(readConfirmDialogState()).not.toHaveProperty("threadActivity");
    respondToConfirmDialog(false);
    await expect(first).resolves.toBe(false);
    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toMatchObject({ status: "confirming", threadActivity });
    respondToConfirmDialog(false);
    await expect(restart).resolves.toBe(false);
    expect(readConfirmDialogState()).toMatchObject({ status: "closing", threadActivity });
    completeConfirmDialogClose();
    const next = requireConfirmation(requestConfirmDialog("Delete the worktree?"));
    expect(readConfirmDialogState()).not.toHaveProperty("threadActivity");
    respondToConfirmDialog(false);
    await expect(next).resolves.toBe(false);
    unregister();
  });

  it("cancels active and queued confirmations if the last host unmounts", async () => {
    const unregister = mountHost();
    const active = requireConfirmation(requestConfirmDialog("Delete the thread?"));
    const queued = requireConfirmation(requestConfirmDialog("Delete the worktree too?"));

    unregister();

    await expect(Promise.all([active, queued])).resolves.toEqual([false, false]);
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
  });

  it("has no host until one subscribes", () => {
    expect(requestConfirmDialog("Continue?")).toBeUndefined();
    const unsubscribe = mountHost();
    expect(requestConfirmDialog("Continue?")).toBeDefined();
    unsubscribe();
    expect(requestConfirmDialog("Continue?")).toBeUndefined();
  });

  it("ignores responses after the active dialog has been closed", () => {
    const unregister = mountHost();
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
  const unregister = mountHost();
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
  const unregister = mountHost();
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
  const unregister = mountHost();
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

it("shows content that arrives after the dialog opened, until it is answered", async () => {
  resetConfirmDialogForTests();
  const unregister = mountHost();
  let update!: (message: string, options?: { confirmLabel?: string }) => void;
  const confirmation = requireConfirmation(
    requestConfirmDialog(
      "Update the build-box server?\nChecking for running work…",
      { confirmLabel: "Update anyway" },
      { checking: true, bindContentUpdate: (replace) => (update = replace) },
    ),
  );
  expect(readConfirmDialogState()).toMatchObject({ checking: true });
  update("Update the build-box server?\nNothing running will be interrupted.", {
    confirmLabel: "Update",
  });
  expect(readConfirmDialogState()).toEqual({
    status: "confirming",
    message: "Update the build-box server?\nNothing running will be interrupted.",
    variant: "default",
    confirmLabel: "Update",
    previousConfirmLabel: "Update anyway",
  });

  respondToConfirmDialog(false);
  update("Update the build-box server?\nLate result.", { confirmLabel: "Update" });
  expect(readConfirmDialogState().status).toBe("closing");
  await expect(confirmation).resolves.toBe(false);
  completeConfirmDialogClose();
  expect(readConfirmDialogState()).toEqual({ status: "idle" });
  unregister();
});

it("applies content updates to a queued dialog when it opens", async () => {
  resetConfirmDialogForTests();
  const unregister = mountHost();
  const first = requireConfirmation(requestConfirmDialog("Delete this thread?"));
  let update!: (message: string, options?: { confirmLabel?: string }) => void;
  const second = requireConfirmation(
    requestConfirmDialog("Update the server?\nChecking for running work…", undefined, {
      bindContentUpdate: (replace) => (update = replace),
    }),
  );
  update("Update the server?\nNothing running will be interrupted.", { confirmLabel: "Update" });
  expect(readConfirmDialogState()).toMatchObject({ message: "Delete this thread?" });

  respondToConfirmDialog(true);
  await expect(first).resolves.toBe(true);
  completeConfirmDialogClose();
  expect(readConfirmDialogState()).toMatchObject({
    status: "confirming",
    message: "Update the server?\nNothing running will be interrupted.",
    confirmLabel: "Update",
  });
  respondToConfirmDialog(true);
  await expect(second).resolves.toBe(true);
  unregister();
});

it("ignores a confirm click just after the dialog's content changed", async () => {
  resetConfirmDialogForTests();
  const unregister = mountHost();
  using now = vi.spyOn(Date, "now").mockReturnValue(10_000);
  let update!: (message: string, options?: { confirmLabel?: string }) => void;
  const confirmation = requireConfirmation(
    requestConfirmDialog("Update the server?\nStill checking…", undefined, {
      bindContentUpdate: (replace) => (update = replace),
    }),
  );
  update("Update the server with running work?\n1 thread will be interrupted.", {
    confirmLabel: "Update",
  });
  now.mockReturnValue(10_300);
  confirmActiveConfirmDialog();
  expect(readConfirmDialogState().status).toBe("confirming");

  now.mockReturnValue(10_500);
  confirmActiveConfirmDialog();
  await expect(confirmation).resolves.toBe(true);
  unregister();
});
