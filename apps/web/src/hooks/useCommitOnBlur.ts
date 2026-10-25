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
 * Buffers input so keystrokes do not re-render settings or send an RPC per character. The draft
 * resyncs from `value` only while unfocused, so an external reset cannot clobber an edit. A
 * promise from `onCommit` keeps the committed text shown until `value` changes; `false` reverts.
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
