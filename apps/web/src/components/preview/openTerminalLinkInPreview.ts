import type { ScopedThreadRef } from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { isPreviewableUrl } from "@t3tools/shared/preview";
import * as Schema from "effect/Schema";

import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import { recordVisitForThread } from "~/browserHistoryStore";
import { applyPreviewServerSnapshot, isPreviewSupportedInRuntime } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

export class TerminalLinkPreviewOpenError extends Schema.TaggedErrorClass<TerminalLinkPreviewOpenError>()(
  "TerminalLinkPreviewOpenError",
  {
    environmentId: Schema.String,
    threadId: Schema.String,
    targetOrigin: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to open terminal link ${this.targetOrigin} in preview for thread ${this.threadId}.`;
  }
}

interface OpenTerminalLinkInPreviewInput<E> {
  readonly url: string;
  readonly threadRef: ScopedThreadRef;
  readonly openPreview: OpenPreviewMutation<E>;
  readonly fallbackToBrowser: () => void;
}

/**
 * Opens a terminal link, in the integrated browser where it is a loopback one.
 *
 * A loopback URL names a port on the machine the terminal runs on, which in a remote environment
 * is not the machine the system browser runs on, and only the integrated browser resolves it
 * against the environment. Activation is already a deliberate modifier gesture, so it opens rather
 * than asking which browser to use; the preview chrome carries the way back out.
 */
export async function openTerminalLinkInPreview<E>(
  input: OpenTerminalLinkInPreviewInput<E>,
): Promise<void> {
  const supportsPreview =
    isPreviewableUrl(input.url) &&
    isPreviewSupportedInRuntime() &&
    input.threadRef.threadId.length > 0;

  if (!supportsPreview) {
    input.fallbackToBrowser();
    return;
  }

  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: { threadId: input.threadRef.threadId, url: input.url },
  });
  if (result._tag === "Failure") {
    if (isAtomCommandInterrupted(result)) {
      return;
    }
    console.error(
      new TerminalLinkPreviewOpenError({
        environmentId: input.threadRef.environmentId,
        threadId: input.threadRef.threadId,
        // The origin only, so a link carrying a token in its path or query is not logged.
        targetOrigin: new URL(input.url).origin,
        cause: result.cause,
      }),
    );
    input.fallbackToBrowser();
    return;
  }
  recordVisitForThread(input.threadRef, input.url);
  applyPreviewServerSnapshot(input.threadRef, result.value);
  useRightPanelStore.getState().openBrowser(input.threadRef, result.value.tabId);
}
