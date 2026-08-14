// Tiny event bus so the composer.dictate keybinding (handled in ChatView) can
// drive the DictationControl in the composer footer without owning its state.
// Mirrors commandPaletteBus.

const DICTATION_TOGGLE_EVENT = "t3code:dictation-toggle";

export function toggleDictation(): void {
  window.dispatchEvent(new CustomEvent(DICTATION_TOGGLE_EVENT));
}

export function onToggleDictation(listener: () => void): () => void {
  const handler = () => listener();
  window.addEventListener(DICTATION_TOGGLE_EVENT, handler);
  return () => window.removeEventListener(DICTATION_TOGGLE_EVENT, handler);
}
