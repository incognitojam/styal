import type { UserInputQuestion } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./pendingUserInput";
import {
  setPendingUserInputQuestionIndex,
  updatePendingUserInputAnswer,
  usePendingUserInputDrafts,
} from "./pendingUserInputDrafts";

const store: UserInputQuestion = {
  id: "store",
  header: "Store",
  question: "Where should cached widgets live?",
  options: [
    { label: "Memory", description: "Fastest." },
    { label: "SQLite", description: "Survives restarts." },
  ],
  multiSelect: false,
};
const ttl: UserInputQuestion = {
  id: "ttl",
  header: "TTL",
  question: "How long should entries live?",
  options: [
    { label: "5 minutes", description: "Short." },
    { label: "1 hour", description: "Long." },
  ],
  multiSelect: false,
};
const requestA = JSON.stringify(["env-1", "thread-1", "request-a"]);
const requestB = JSON.stringify(["env-1", "thread-2", "request-b"]);

describe("pending question drafts", () => {
  beforeEach(() => {
    usePendingUserInputDrafts.setState({ answersByRequestKey: {}, questionIndexByRequestKey: {} });
  });

  it("builds the submitted answers from drafts kept per question and request", () => {
    updatePendingUserInputAnswer(requestA, store.id, (draft) =>
      setPendingUserInputCustomAnswer(draft, "Redis with LRU eviction"),
    );
    updatePendingUserInputAnswer(requestA, ttl.id, (draft) =>
      togglePendingUserInputOptionSelection(ttl, draft, "1 hour"),
    );
    setPendingUserInputQuestionIndex(requestA, 1);
    updatePendingUserInputAnswer(requestB, store.id, (draft) =>
      togglePendingUserInputOptionSelection(store, draft, "SQLite"),
    );

    const { answersByRequestKey, questionIndexByRequestKey } = usePendingUserInputDrafts.getState();
    expect(buildPendingUserInputAnswers([store, ttl], answersByRequestKey[requestA] ?? {})).toEqual(
      { store: "Redis with LRU eviction", ttl: "1 hour" },
    );
    expect(buildPendingUserInputAnswers([store], answersByRequestKey[requestB] ?? {})).toEqual({
      store: "SQLite",
    });
    expect(questionIndexByRequestKey).toEqual({ [requestA]: 1 });
  });

  it("replaces a typed answer when an option is picked afterwards", () => {
    updatePendingUserInputAnswer(requestA, store.id, (draft) =>
      setPendingUserInputCustomAnswer(draft, "Redis"),
    );
    updatePendingUserInputAnswer(requestA, store.id, (draft) =>
      togglePendingUserInputOptionSelection(store, draft, "Memory"),
    );

    const drafts = usePendingUserInputDrafts.getState().answersByRequestKey[requestA] ?? {};
    expect(buildPendingUserInputAnswers([store], drafts)).toEqual({ store: "Memory" });
  });
});
