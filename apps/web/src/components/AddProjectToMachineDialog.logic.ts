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
  // Without a list, files such as .env could be left behind unnoticed.
  if (defaultCopies === "failed" || defaultCopies === "unsupported" || destination === "failed") {
    return "ask";
  }
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

/**
 * What the source's ignored files say about copying: how many are ticked by default, or why that
 * is not known. A listing the server could not make reports `failed`, so it is not "no files".
 */
export function defaultCopiesState(input: {
  readonly canListFiles: boolean;
  readonly error: string | null;
  readonly data: { readonly failed?: boolean } | null;
  readonly answered: boolean;
  readonly defaultCount: number;
}): number | "unsupported" | "loading" | "failed" {
  if (!input.canListFiles) return "unsupported";
  if (input.error !== null || input.data?.failed === true) return "failed";
  return input.answered ? input.defaultCount : "loading";
}
