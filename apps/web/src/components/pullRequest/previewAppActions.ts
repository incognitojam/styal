import type { DesktopPreviewAppActionResult } from "@t3tools/contracts";

import { readLocalApi } from "~/localApi";
import { getDesktopPreviewAppBridge } from "~/state/desktopPreviewApp";
import { stackedThreadToast, toastManager } from "../ui/toast";

const reportFailure = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

const settle = (title: string, action: Promise<DesktopPreviewAppActionResult>) =>
  void action
    .then((result) => {
      if (result.outcome === "failed")
        reportFailure(title, result.message ?? "Something went wrong.");
    })
    .catch((error: unknown) =>
      reportFailure(title, error instanceof Error ? error.message : "Something went wrong."),
    );

/** The person's clicks on preview controls, shared by the pull request panel and Settings. */
export const previewAppActions = {
  install: (pullRequestNumber: number) => {
    const bridge = getDesktopPreviewAppBridge();
    if (bridge) settle("Could not install the preview", bridge.install(pullRequestNumber));
  },
  cancelInstall: () => void getDesktopPreviewAppBridge()?.cancelInstall(),
  open: () => {
    const bridge = getDesktopPreviewAppBridge();
    if (bridge) settle("Could not open the preview", bridge.open());
  },
  remove: () => {
    const bridge = getDesktopPreviewAppBridge();
    if (bridge) settle("Could not remove the preview", bridge.remove());
  },
  resetData: () => {
    const bridge = getDesktopPreviewAppBridge();
    if (!bridge) return;
    void readLocalApi()
      ?.dialogs.confirm(
        "Reset preview data?\n\nThis quits styal (Preview) and deletes its projects, threads, settings, and sign-ins. Your main styal app is not affected.",
      )
      .then((confirmed) => {
        if (confirmed) settle("Could not reset preview data", bridge.resetData());
      });
  },
};
