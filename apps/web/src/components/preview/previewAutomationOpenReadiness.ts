import {
  FILL_PREVIEW_VIEWPORT,
  type PreviewAutomationOpenInput,
  type PreviewAutomationPresentation,
  type PreviewSessionSnapshot,
  type PreviewViewportSetting,
} from "@t3tools/contracts";

export const DEFAULT_PREVIEW_AUTOMATION_VIEWPORT = {
  _tag: "freeform",
  width: 1280,
  height: 800,
} as const satisfies PreviewViewportSetting;

export function shouldOpenPreviewMiniPlayer(input: PreviewAutomationOpenInput): boolean {
  return input.open ?? input.show ?? true;
}

export function resolvePreviewAutomationPresentation(
  input: PreviewAutomationOpenInput,
  presentation: PreviewAutomationPresentation | undefined,
): PreviewAutomationPresentation | null {
  return shouldOpenPreviewMiniPlayer(input) ? (presentation ?? "mini-player") : null;
}

export function previewAutomationOpenNeedsOverlay(
  input: PreviewAutomationOpenInput,
  snapshot: PreviewSessionSnapshot,
  presentation?: PreviewAutomationPresentation,
): boolean {
  // A terminal browser-open only needs the panel/tab state accepted. The
  // originating terminal may be in a background thread whose webview cannot
  // mount until the user returns to it.
  if (presentation === "right-panel") return false;
  return input.url !== undefined || snapshot.navStatus._tag !== "Idle";
}

export function previewAutomationDefaultViewport(
  reusedExistingTab: boolean,
  snapshot: PreviewSessionSnapshot,
): PreviewViewportSetting | null {
  const viewport = snapshot.viewport ?? FILL_PREVIEW_VIEWPORT;
  return !reusedExistingTab && viewport._tag === "fill"
    ? DEFAULT_PREVIEW_AUTOMATION_VIEWPORT
    : null;
}
