// The sidebar owns thread order and attention, so the command palette asks it
// to open the next thread that needs the user instead of computing its own.
const NEXT_UNREAD_THREAD_EVENT = "styal:open-next-unread-thread";

export function requestNextUnreadThread(): void {
  window.dispatchEvent(new Event(NEXT_UNREAD_THREAD_EVENT));
}

export function subscribeNextUnreadThread(listener: () => void): () => void {
  window.addEventListener(NEXT_UNREAD_THREAD_EVENT, listener);
  return () => window.removeEventListener(NEXT_UNREAD_THREAD_EVENT, listener);
}
