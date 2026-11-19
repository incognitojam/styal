import type { ThreadPendingUserInput } from "@t3tools/client-runtime/state/thread-requests";

/** Oldest first across kinds; the key keeps rows with the same time in a stable order. */
export function oldestFirst<Row>(
  rows: ReadonlyArray<Row>,
  at: (row: Row) => string,
  key: (row: Row) => string,
): Row[] {
  return [...rows].sort((a, b) => at(a).localeCompare(at(b)) || key(a).localeCompare(key(b)));
}

/** The question one tap answers: a single single-select question with options. */
export function oneTapQuestion(userInput: ThreadPendingUserInput) {
  const [question, ...others] = userInput.questions;
  return question !== undefined &&
    others.length === 0 &&
    question.multiSelect !== true &&
    question.options.length > 0
    ? question
    : null;
}
