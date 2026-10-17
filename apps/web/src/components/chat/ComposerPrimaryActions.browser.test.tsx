import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

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
