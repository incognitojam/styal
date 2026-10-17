import { beforeEach, describe, expect, it } from "vite-plus/test";
import { ThreadId, type ConfirmDialogThreadActivity } from "@t3tools/contracts";

import {
  acknowledgeConfirmDialogPresentation,
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  requestConfirmDialog,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "./confirmDialog";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

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

  it("waits to prepare a queued dialog and never replaces the active confirmation", async () => {
    const unregister = registerConfirmDialogHost();
    const content = deferred<{ message: string }>();
    let checks = 0;
    const first = requireConfirmation(requestConfirmDialog("Delete this thread?"));
    const update = requireConfirmation(
      requestConfirmDialog(
        "Update?\nChecking…",
        { confirmLabel: "Update" },
        {
          prepare: () => {
            checks++;
            return content.promise;
          },
        },
      ),
    );
    expect(checks).toBe(0);
    expect(readConfirmDialogState()).toMatchObject({ message: "Delete this thread?" });
    respondToConfirmDialog(false);
    await first;
    completeConfirmDialogClose();
    expect(checks).toBe(1);
    expect(readConfirmDialogState()).toMatchObject({ loading: true });
    content.resolve({ message: "Update?\n1 thread will be interrupted." });
    await content.promise;
    expect(readConfirmDialogState()).toMatchObject({
      message: "Update?\n1 thread will be interrupted.",
    });
    expect(readConfirmDialogState()).not.toHaveProperty("loading");
    respondToConfirmDialog(false);
    await expect(update).resolves.toBe(false);
    unregister();
  });

  it("cancels when preparation rejects instead of admitting an unchecked action", async () => {
    const unregister = registerConfirmDialogHost();
    const confirmation = requireConfirmation(
      requestConfirmDialog("Update?", undefined, {
        prepare: () => Promise.reject(new Error("Connection lost")),
      }),
    );
    await expect(confirmation).resolves.toBe(false);
    expect(readConfirmDialogState().status).toBe("closing");
    unregister();
  });

  it("advances the queue when a check needs no confirmation before the dialog renders", async () => {
    const unregister = registerConfirmDialogHost();
    const idle = requireConfirmation(
      requestConfirmDialog("Update?", undefined, { prepare: async () => null }),
    );
    const next = requireConfirmation(requestConfirmDialog("Delete the project?"));
    await expect(idle).resolves.toBe(true);
    expect(readConfirmDialogState()).toMatchObject({
      status: "confirming",
      message: "Delete the project?",
    });
    respondToConfirmDialog(false);
    await expect(next).resolves.toBe(false);
    unregister();
  });

  it("ignores preparation results after the last host unmounts", async () => {
    const unregister = registerConfirmDialogHost();
    const content = deferred<null>();
    const confirmation = requireConfirmation(
      requestConfirmDialog("Update?", undefined, { prepare: () => content.promise }),
    );
    unregister();
    await expect(confirmation).resolves.toBe(false);
    content.resolve(null);
    await content.promise;
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
  });

  it.each(["cancel", "abort"] as const)(
    "ignores late warning content after %s during loading",
    async (action) => {
      const unregister = registerConfirmDialogHost();
      const controller = new AbortController();
      const content = deferred<{ message: string }>();
      const confirmation = requireConfirmation(
        requestConfirmDialog("Update?\nChecking…", undefined, {
          signal: controller.signal,
          prepare: () => content.promise,
        }),
      );
      acknowledgeConfirmDialogPresentation(readConfirmDialogState());
      if (action === "cancel") respondToConfirmDialog(false);
      else controller.abort();
      await expect(confirmation).resolves.toBe(false);
      completeConfirmDialogClose();
      content.resolve({ message: "Update?\n1 thread will be interrupted." });
      await content.promise;
      expect(readConfirmDialogState()).toEqual({ status: "idle" });
      unregister();
    },
  );

  it("waits for the close transition when an idle check finishes after presentation", async () => {
    const unregister = registerConfirmDialogHost();
    const content = deferred<null>();
    const idle = requireConfirmation(
      requestConfirmDialog("Update?\nChecking…", undefined, { prepare: () => content.promise }),
    );
    acknowledgeConfirmDialogPresentation(readConfirmDialogState());
    const next = requireConfirmation(requestConfirmDialog("Delete the project?"));
    content.resolve(null);
    await expect(idle).resolves.toBe(true);
    expect(readConfirmDialogState()).toMatchObject({
      status: "closing",
      message: "Update?\nChecking…",
    });
    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toMatchObject({
      status: "confirming",
      message: "Delete the project?",
    });
    respondToConfirmDialog(false);
    await expect(next).resolves.toBe(false);
    unregister();
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

  it("keeps queued thread details with their dialog through dismissal, then clears them", async () => {
    const unregister = registerConfirmDialogHost();
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
