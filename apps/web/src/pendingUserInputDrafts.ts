import { create } from "zustand";

import type { PendingUserInputDraftAnswer } from "./pendingUserInput";

/**
 * Unsubmitted question answers and the question each request shows, keyed by
 * `JSON.stringify([environmentId, threadId, requestId])`. They live outside
 * ChatView so a remount, such as after an environment reconnects, keeps what
 * the user typed. Attachments stay in the question's composer draft.
 */
export const usePendingUserInputDrafts = create<{
  answersByRequestKey: Record<string, Record<string, PendingUserInputDraftAnswer>>;
  questionIndexByRequestKey: Record<string, number>;
}>(() => ({ answersByRequestKey: {}, questionIndexByRequestKey: {} }));

export function updatePendingUserInputAnswer(
  requestKey: string,
  questionId: string,
  update: (draft: PendingUserInputDraftAnswer | undefined) => PendingUserInputDraftAnswer,
): void {
  usePendingUserInputDrafts.setState(({ answersByRequestKey }) => ({
    answersByRequestKey: {
      ...answersByRequestKey,
      [requestKey]: {
        ...answersByRequestKey[requestKey],
        [questionId]: update(answersByRequestKey[requestKey]?.[questionId]),
      },
    },
  }));
}

export function setPendingUserInputQuestionIndex(requestKey: string, questionIndex: number): void {
  usePendingUserInputDrafts.setState(({ questionIndexByRequestKey }) => ({
    questionIndexByRequestKey: { ...questionIndexByRequestKey, [requestKey]: questionIndex },
  }));
}
