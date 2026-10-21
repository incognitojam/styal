import "~/index.css";

import { expect, it, vi } from "vite-plus/test";

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));

import { render } from "../../../test/render";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

it("explains why sending is disabled while feedback is uploading", async () => {
  await using screen = await render(
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
  );

  const send = screen.container.querySelector<HTMLButtonElement>(
    'button[aria-label="Sending feedback"]',
  );
  expect(send?.disabled).toBe(true);
  // A disabled button takes no focus, so the reason sits on a focusable tooltip trigger.
  const trigger = send?.closest<HTMLElement>('[data-slot="tooltip-trigger"]');
  expect(trigger?.tabIndex).toBe(0);
});
