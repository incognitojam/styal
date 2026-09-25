import { type ChangeEvent, type KeyboardEvent, useState } from "react";

/**
 * A commit that is saving: the text the user entered, and the value it
 * replaced. Shown until `value` moves off `from`.
 */
interface PendingCommit {
  readonly next: string;
  readonly from: string;
}

/**
 * Buffer text input locally so keystrokes don't cause a settings-wide
 * re-render (and optionally a server RPC round-trip) on every character.
 * `onCommit` fires on blur and on Enter.
 *
 * The draft resynchronizes from the upstream `value` only when the input
 * is not focused, so an external push (e.g. a reset to defaults) doesn't
 * clobber an in-progress edit.
 *
 * When `onCommit` returns a promise, the committed text stays visible until
 * `value` changes, instead of showing the old value while the save is in
 * flight. If the promise resolves to `false`, the input returns to `value`.
 *
 * Returns a bag of props that should be spread onto an `<Input>`:
 *
 *   const bag = useCommitOnBlur(instance.displayName ?? "", (next) => {...});
 *   <Input {...bag} placeholder="e.g. Work" />
 */
export function useCommitOnBlur(
  value: string,
  onCommit: (next: string) => void | Promise<boolean>,
) {
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingCommit | null>(null);

  // The saved value arrived, or something else changed it.
  if (pending !== null && value !== pending.from) {
    setPending(null);
  }

  return {
    value: draft ?? pending?.next ?? value,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      setDraft(event.target.value);
    },
    onFocus: () => {
      setDraft(pending?.next ?? value);
    },
    onBlur: () => {
      const next = draft ?? value;
      setDraft(null);
      if (next === (pending?.next ?? value)) return;
      const saving = onCommit(next);
      if (saving === undefined) return;
      const commit = { next, from: value };
      setPending(commit);
      void saving.then((saved) => {
        if (!saved) {
          setPending((current) => (current === commit ? null : current));
        }
      });
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        event.preventDefault();
        (event.target as HTMLInputElement).blur();
      }
    },
  };
}
