export function assistantSelectionToolbarPosition({
  selection,
  toolbar,
  viewport,
  windowSize,
}: {
  selection: { left: number; top: number; width: number; bottom: number };
  toolbar: { width: number; height: number };
  viewport: { top: number; bottom: number };
  windowSize: { width: number; height: number };
}) {
  const lowerEdge = Math.min(viewport.bottom, windowSize.height) - 8;
  const upperEdge = Math.max(8, viewport.top);
  const above = selection.top - toolbar.height - 8;
  const below = selection.bottom + 8;
  const preferredTop = above >= upperEdge ? above : below;
  return {
    left: Math.max(
      8,
      Math.min(
        selection.left + selection.width / 2 - toolbar.width / 2,
        windowSize.width - toolbar.width - 8,
      ),
    ),
    top: Math.max(upperEdge, Math.min(preferredTop, lowerEdge - toolbar.height)),
  };
}
