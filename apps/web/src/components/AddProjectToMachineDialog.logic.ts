export type QuickAddDecision = "wait" | "start" | "ask";

/**
 * Adding to a named machine starts at once only when there is nothing to decide: no ignored file
 * would be copied by default, and the default folder does not exist there yet. Anything that
 * could not be checked asks too.
 */
export function quickAddDecision(input: {
  /** The clicked machine is still one the project can be added to. */
  readonly targetAvailable: boolean;
  /** Ignored files ticked by default, or why the count is not known. */
  readonly defaultCopies: number | "unsupported" | "loading" | "failed";
  readonly destination: "missing" | "exists" | "loading" | "failed";
  /** The checks took too long; the dialog shows them loading instead of nothing happening. */
  readonly waitedTooLong: boolean;
}): QuickAddDecision {
  const { defaultCopies, destination } = input;
  if (!input.targetAvailable) return "ask";
  if (defaultCopies === "failed" || destination === "failed") return "ask";
  if (typeof defaultCopies === "number" && defaultCopies > 0) return "ask";
  if (destination === "exists") return "ask";
  if (defaultCopies === "loading" || destination === "loading") {
    return input.waitedTooLong ? "ask" : "wait";
  }
  return "start";
}

/**
 * A check counts only when answered after the click, so a cached answer from an earlier dialog
 * cannot skip a question about files or a folder that has changed since.
 */
export function answeredSince(
  query: { readonly data: unknown; readonly dataUpdatedAt: number; readonly isPending: boolean },
  openedAt: number,
): boolean {
  return query.data !== null && !query.isPending && query.dataUpdatedAt >= openedAt;
}
