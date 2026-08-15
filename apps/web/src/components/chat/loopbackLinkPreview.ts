import { isPreviewableUrl } from "@t3tools/shared/preview";

interface LoopbackLinkClickEvent {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

/**
 * Whether a chat link should open in the integrated browser rather than follow its `_blank`.
 *
 * Only loopback links do: they name a port on the machine the thread runs on, which in a remote
 * environment is not the machine the system browser runs on, and only the integrated browser
 * resolves them against the environment. A modifier still follows the link itself.
 */
export function shouldOpenLinkInIntegratedBrowser(input: {
  readonly href: string;
  readonly event: LoopbackLinkClickEvent;
  /** False without a thread to open beside, or in a runtime with no integrated browser. */
  readonly canOpenInPreview: boolean;
}): boolean {
  if (!input.canOpenInPreview) return false;
  if (input.event.metaKey || input.event.ctrlKey) return false;
  return isPreviewableUrl(input.href);
}
