import type { ReactNode } from "react";

export interface SheetProps {
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
  /** Blocks the close button and the swipe, such as while a submit is in flight. */
  readonly dismissDisabled?: boolean;
  /** Android: as tall as its content, up to three quarters of the screen. iOS keeps half height. */
  readonly fitToContents?: boolean;
}
