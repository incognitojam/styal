import { create } from "zustand";

import type { SidebarThreadAttention } from "../Sidebar.logic";

export type NextUnreadEntryPoint = "shortcut" | "command_palette" | "chip";

// The sidebar owns thread order and attention, so the command palette and the
// chip above the composer ask it to open the next unread thread instead of
// computing their own.
const NEXT_UNREAD_THREAD_EVENT = "styal:open-next-unread-thread";

export function requestNextUnreadThread(entryPoint: Exclude<NextUnreadEntryPoint, "shortcut">) {
  window.dispatchEvent(new CustomEvent(NEXT_UNREAD_THREAD_EVENT, { detail: entryPoint }));
}

export function subscribeNextUnreadThread(
  listener: (entryPoint: Exclude<NextUnreadEntryPoint, "shortcut">) => void,
): () => void {
  const handle = (event: Event) => {
    const entryPoint = (event as CustomEvent<unknown>).detail;
    listener(entryPoint === "chip" ? "chip" : "command_palette");
  };
  window.addEventListener(NEXT_UNREAD_THREAD_EVENT, handle);
  return () => window.removeEventListener(NEXT_UNREAD_THREAD_EVENT, handle);
}

/** Threads other than the open one that are waiting, as the sidebar last counted them. */
export interface NextUnreadSummary {
  readonly count: number;
  readonly attention: SidebarThreadAttention;
}

export const useNextUnreadSummary = create<{ summary: NextUnreadSummary | null }>(() => ({
  summary: null,
}));

export function publishNextUnreadSummary(summary: NextUnreadSummary | null) {
  const current = useNextUnreadSummary.getState().summary;
  if (current?.count === summary?.count && current?.attention === summary?.attention) return;
  useNextUnreadSummary.setState({ summary });
}
