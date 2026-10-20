import "~/index.css";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("explains why sending is disabled while feedback is uploading", async () => {
  await act(() =>
    root.render(
      <ComposerPrimaryActions
        compact
        canOperateThread
        pendingAction={null}
        isRunning={false}
        canInterrupt={false}
        showPlanFollowUpPrompt={false}
        promptHasText
        isSendBusy={false}
        sendDisabledReason="Sending feedback"
        isConnecting={false}
        isEnvironmentUnavailable={false}
        isPreparingWorktree={false}
        hasSendableContent
        onPreviousPendingQuestion={() => {}}
        onInterrupt={() => {}}
        onImplementPlanInNewThread={() => {}}
      />,
    ),
  );

  const send = container.querySelector<HTMLButtonElement>('button[aria-label="Sending feedback"]');
  expect(send?.disabled).toBe(true);
  // A disabled button takes no focus, so the reason sits on a focusable tooltip trigger.
  const trigger = send?.closest<HTMLElement>('[data-slot="tooltip-trigger"]');
  expect(trigger?.tabIndex).toBe(0);
});

it("opens implementation actions with a mouse while the composer is resting", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onImplementPlanInNewThread = vi.fn();

  try {
    await act(async () => {
      root.render(
        <ComposerPrimaryActions
          compact={false}
          canOperateThread
          pendingAction={null}
          isRunning={false}
          canInterrupt={false}
          showPlanFollowUpPrompt
          promptHasText={false}
          isSendBusy={false}
          sendDisabledReason={null}
          isConnecting={false}
          isEnvironmentUnavailable={false}
          isPreparingWorktree={false}
          hasSendableContent={false}
          preserveComposerFocusOnPointerDown
          onPreviousPendingQuestion={() => {}}
          onInterrupt={() => {}}
          onImplementPlanInNewThread={onImplementPlanInNewThread}
        />,
      );
    });

    await act(async () => {
      await userEvent.click(page.getByRole("button", { name: "Implementation actions" }));
    });
    const item = page.getByRole("menuitem", { name: "Implement in a new thread" });
    await expect.element(item).toBeVisible();
    await act(async () => {
      await userEvent.click(item);
    });
    expect(onImplementPlanInNewThread).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
