export type QuickAddDecision = "wait" | "start" | "ask";

/**
 * Adding to a named machine starts at once only when there is nothing to decide: no ignored file
 * would be copied by default, and the default folder does not exist there yet. Anything that
 * could not be checked asks too.
 */
export function quickAddDecision(input: {
  /** Ignored files ticked by default, or why the count is not known. */
  readonly defaultCopies: number | "unsupported" | "loading" | "failed";
  readonly destination: "missing" | "exists" | "loading" | "failed";
}): QuickAddDecision {
  const { defaultCopies, destination } = input;
  if (defaultCopies === "failed" || destination === "failed") return "ask";
  if (typeof defaultCopies === "number" && defaultCopies > 0) return "ask";
  if (destination === "exists") return "ask";
  if (defaultCopies === "loading" || destination === "loading") return "wait";
  return "start";
}
