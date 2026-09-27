export interface HostFocusElement {
  readonly tagName: string;
  readonly isConnected: boolean;
  getAttribute(name: string): string | null;
  focus(options?: FocusOptions): void;
  blur(): void;
}

// Electron reports the guest as focused even before a click, so only the host document knows what to restore.
export async function keepHostFocusDuringGuestInput<A>(
  runtimeTabId: string,
  readActiveElement: () => HostFocusElement | null,
  action: () => Promise<A>,
): Promise<A> {
  const previous = readActiveElement();
  // A human click in the page interrupts the agent's action, so only a completed action restores focus.
  const result = await action();
  const current = readActiveElement();
  if (
    current !== null &&
    current !== previous &&
    current.tagName === "WEBVIEW" &&
    current.getAttribute("data-preview-tab") === runtimeTabId
  ) {
    if (previous !== null && previous.isConnected && previous.tagName !== "BODY") {
      previous.focus({ preventScroll: true });
    } else {
      current.blur();
    }
  }
  return result;
}
