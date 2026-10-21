import { ChevronDownIcon, PaperclipIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";

export function WorkspaceFileDropOverlay() {
  return (
    <div
      className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.035]"
      data-chat-workspace-drop-overlay="true"
    >
      <div
        role="status"
        className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/95 px-4 py-2.5 text-sm font-medium text-foreground shadow-lg"
      >
        <PaperclipIcon className="size-4 text-primary" aria-hidden="true" />
        Drop files to attach
      </div>
    </div>
  );
}

/**
 * Sits `bottom` pixels up, clear of the composer and its attached banners. Children share its
 * row, and ChatView's clearance measurement covers every button in the row.
 */
export function ScrollToEndButton(props: {
  readonly bottom: number;
  readonly onScrollToEnd: () => void;
  readonly children?: ReactNode;
}) {
  return (
    <div
      data-scroll-to-end-row="true"
      className="chat-scroll-to-bottom pointer-events-none absolute z-30 flex justify-center gap-2 py-1.5"
      style={{ bottom: props.bottom }}
    >
      <Button
        aria-label="Scroll to end"
        onPointerDown={(event) => event.preventDefault()}
        onClick={props.onScrollToEnd}
        className="pointer-events-auto"
        size="xs"
        variant="glass"
      >
        <ChevronDownIcon className="size-3.5" />
        Scroll to end
      </Button>
      {props.children}
    </div>
  );
}
