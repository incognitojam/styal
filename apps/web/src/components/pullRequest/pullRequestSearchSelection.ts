export interface PullRequestSearchSelection {
  readonly start: number;
  readonly end: number;
  readonly direction: "forward" | "backward" | "none";
}

type ReadableSearchInput = Pick<
  HTMLInputElement,
  "value" | "selectionStart" | "selectionEnd" | "selectionDirection"
>;

type WritableSearchInput = Pick<HTMLInputElement, "value" | "setSelectionRange">;

/** Preserves the user's caret or selection while the responsive search input changes location. */
export function readPullRequestSearchSelection(
  input: ReadableSearchInput,
): PullRequestSearchSelection {
  const fallback = input.value.length;
  return {
    start: input.selectionStart ?? fallback,
    end: input.selectionEnd ?? fallback,
    direction: input.selectionDirection ?? "none",
  };
}

/** Restores a saved selection, bounded to the value rendered by the receiving input. */
export function restorePullRequestSearchSelection(
  input: WritableSearchInput,
  selection: PullRequestSearchSelection | null,
): void {
  const length = input.value.length;
  if (!selection) {
    input.setSelectionRange(length, length);
    return;
  }
  input.setSelectionRange(
    Math.min(selection.start, length),
    Math.min(selection.end, length),
    selection.direction,
  );
}
