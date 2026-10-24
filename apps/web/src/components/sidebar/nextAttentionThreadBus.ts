// The sidebar owns thread order and attention, so the command palette asks it
// to open the next thread that needs the user instead of computing its own.
const NEXT_ATTENTION_THREAD_EVENT = "styal:open-next-attention-thread";

export function requestNextAttentionThread(): void {
  window.dispatchEvent(new Event(NEXT_ATTENTION_THREAD_EVENT));
}

export function subscribeNextAttentionThread(listener: () => void): () => void {
  window.addEventListener(NEXT_ATTENTION_THREAD_EVENT, listener);
  return () => window.removeEventListener(NEXT_ATTENTION_THREAD_EVENT, listener);
}
