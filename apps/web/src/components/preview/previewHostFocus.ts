export interface HostFocusElement {
  readonly tagName: string;
  readonly isConnected: boolean;
  getAttribute(name: string): string | null;
  focus(options?: FocusOptions): void;
  blur(): void;
}

const isHumanInterruption = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "PreviewAutomationControlInterruptedError";

const restoreHostFocus = (
  runtimeTabId: string,
  previous: HostFocusElement | null,
  current: HostFocusElement | null,
): void => {
  if (
    current === null ||
    current === previous ||
    current.tagName !== "WEBVIEW" ||
    current.getAttribute("data-preview-tab") !== runtimeTabId
  ) {
    return;
  }
  if (previous !== null && previous.isConnected && previous.tagName !== "BODY") {
    previous.focus({ preventScroll: true });
  } else {
    current.blur();
  }
};

// Electron reports the guest as focused even before a click, so only the host document knows what to restore.
export async function keepHostFocusDuringGuestInput<A>(
  runtimeTabId: string,
  readActiveElement: () => HostFocusElement | null,
  action: () => Promise<A>,
): Promise<A> {
  const previous = readActiveElement();
  let result: A;
  try {
    result = await action();
  } catch (error) {
    // A human click in the page interrupts the agent's action, and that focus belongs to the user.
    if (!isHumanInterruption(error)) {
      restoreHostFocus(runtimeTabId, previous, readActiveElement());
    }
    throw error;
  }
  restoreHostFocus(runtimeTabId, previous, readActiveElement());
  return result;
}
