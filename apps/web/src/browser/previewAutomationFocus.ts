import { findBrowserWebview } from "./browserCaptureSurface";

const PREVIEW_AUTOMATION_FOCUS_SETTLE_MS = 250;

interface ActivePreviewAutomationFocusGuard {
  readonly runtimeTabId: string;
  readonly previouslyFocused: HTMLElement;
  readonly acceptHumanInput: () => void;
}

const activeFocusGuards = new Set<ActivePreviewAutomationFocusGuard>();

const isActiveAutomationWebview = (element: Element | null): boolean => {
  if (!element) return false;
  return Array.from(activeFocusGuards).some(
    (guard) => findBrowserWebview(guard.runtimeTabId) === element,
  );
};

/**
 * Accept a trusted guest-input signal after the desktop manager has excluded
 * automation-generated packets.
 */
export function notifyPreviewHumanInput(runtimeTabId: string): void {
  for (const guard of Array.from(activeFocusGuards)) {
    if (guard.runtimeTabId === runtimeTabId) guard.acceptHumanInput();
  }
}

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
  let restoredAutomationFocus = false;
  let listening = true;
  let guard: ActivePreviewAutomationFocusGuard;

  const cleanup = () => {
    if (!listening) return;
    listening = false;
    activeFocusGuards.delete(guard);
    document.removeEventListener("focusin", onFocusIn, true);
  };
  const restore = () => {
    if (focusSuperseded || !previouslyFocused.isConnected) return;
    const currentWebview = findBrowserWebview(runtimeTabId);
    if (!currentWebview || document.activeElement !== currentWebview) return;
    try {
      previouslyFocused.focus({ preventScroll: true });
      restoredAutomationFocus = document.activeElement === previouslyFocused;
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
  const acceptHumanInput = () => {
    focusSuperseded = true;
    cleanup();
    if (!restoredAutomationFocus || document.activeElement !== previouslyFocused) return;
    const currentWebview = findBrowserWebview(runtimeTabId);
    if (!(currentWebview instanceof HTMLElement)) return;
    try {
      currentWebview.focus({ preventScroll: true });
    } catch {
      // The guest can detach between its input signal and renderer delivery.
    }
  };

  guard = { runtimeTabId, previouslyFocused, acceptHumanInput };
  activeFocusGuards.add(guard);

  document.addEventListener("focusin", onFocusIn, true);
  try {
    return await operation();
  } finally {
    // A failed click can be the same event that focuses the guest. Restore on
    // both outcomes and retain the guard for delayed Electron focus delivery.
    restore();
    window.setTimeout(cleanup, PREVIEW_AUTOMATION_FOCUS_SETTLE_MS);
  }
}
