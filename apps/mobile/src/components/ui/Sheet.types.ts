import type { ReactNode } from "react";

export interface SheetProps {
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
  /** Blocks the close button and the swipe, such as while a submit is in flight. */
  readonly dismissDisabled?: boolean;
  /**
   * As tall as its content, up to three quarters of the screen. Android measures it; iOS sizes to
   * `contentHeight`, the caller's measured scroll content, and stays half height until it arrives.
   */
  readonly fitToContents?: { readonly contentHeight: number | null };
  /** No close button: the sheet is dismissed by dragging it down or tapping outside. */
  readonly hideCloseButton?: boolean;
}
