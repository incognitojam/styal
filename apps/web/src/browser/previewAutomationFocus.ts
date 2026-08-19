import { findBrowserWebview } from "./browserCaptureSurface";

const PREVIEW_AUTOMATION_FOCUS_SETTLE_MS = 250;

interface ActivePreviewAutomationFocusGuard {
  readonly runtimeTabId: string;
  readonly previouslyFocused: HTMLElement;
}

const activeFocusGuards = new Set<ActivePreviewAutomationFocusGuard>();

const isActiveAutomationWebview = (element: Element | null): boolean => {
  if (!element) return false;
  return Array.from(activeFocusGuards).some(
    (guard) => findBrowserWebview(guard.runtimeTabId) === element,
  );
};

/**
 * Preserve the user's active T3 control when Electron delivers delayed guest
 * focus for agent-driven preview input or navigation.
 */
export async function withPreservedPreviewAutomationFocus<A>(
  runtimeTabId: string,
  operation: () => Promise<A>,
): Promise<A> {
  let previouslyFocused = document.activeElement;
  const owningGuard = Array.from(activeFocusGuards).find(
    (guard) => findBrowserWebview(guard.runtimeTabId) === previouslyFocused,
  );
  if (owningGuard) previouslyFocused = owningGuard.previouslyFocused;
  const initialWebview = findBrowserWebview(runtimeTabId);
  if (
    !(previouslyFocused instanceof HTMLElement) ||
    previouslyFocused === document.body ||
    previouslyFocused === (initialWebview as Element | null) ||
    !initialWebview
  ) {
    return await operation();
  }

  let focusSuperseded = false;
  let listening = true;
  const guard: ActivePreviewAutomationFocusGuard = { runtimeTabId, previouslyFocused };
  activeFocusGuards.add(guard);

  const cleanup = () => {
    if (!listening) return;
    listening = false;
    activeFocusGuards.delete(guard);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
  };
  const restore = () => {
    if (focusSuperseded || !previouslyFocused.isConnected) return;
    const currentWebview = findBrowserWebview(runtimeTabId);
    if (!currentWebview || document.activeElement !== currentWebview) return;
    try {
      previouslyFocused.focus({ preventScroll: true });
    } catch {
      // The prior control can become unfocusable while an async action settles.
    }
  };
  const onFocusIn = () => {
    const activeElement = document.activeElement;
    if (activeElement === previouslyFocused) return;
    if (activeElement === findBrowserWebview(runtimeTabId)) {
      restore();
      return;
    }
    if (isActiveAutomationWebview(activeElement)) return;
    focusSuperseded = true;
    cleanup();
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!event.isTrusted) return;
    const currentWebview = findBrowserWebview(runtimeTabId);
    if (!currentWebview || !event.composedPath().includes(currentWebview)) return;
    // A real pointer event in the embedder means the user chose the preview.
    // Cancel before Electron transfers focus so the automation guard cannot
    // bounce intentional interaction back to the previous T3 control.
    focusSuperseded = true;
    cleanup();
  };

  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  try {
    return await operation();
  } finally {
    // A failed click can be the same event that focuses the guest. Restore on
    // both outcomes and retain the guard for delayed Electron focus delivery.
    restore();
    window.setTimeout(cleanup, PREVIEW_AUTOMATION_FOCUS_SETTLE_MS);
  }
}
