/** Returns whether keyboard focus currently belongs to the right panel. */
export function isRightPanelFocused(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  if (!activeElement.isConnected) return false;
  return activeElement.closest("[data-right-panel-focus-boundary]") !== null;
}
