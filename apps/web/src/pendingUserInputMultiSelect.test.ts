import type { UserInputQuestion } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./pendingUserInput";
import {
  setPendingUserInputQuestionIndex,
  updatePendingUserInputAnswer,
  usePendingUserInputDrafts,
} from "./pendingUserInputDrafts";

const areas: UserInputQuestion = {
  id: "areas",
  header: "Areas",
  question: "Which areas should this change cover?",
  options: [
    { label: "Server", description: "Server" },
    { label: "Web", description: "Web" },
  ],
  multiSelect: true,
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
const typed = "  Mobile too, with offline support  ";
const typeAnswer = (draft: Parameters<typeof setPendingUserInputCustomAnswer>[0], text: string) =>
  setPendingUserInputCustomAnswer(draft, text, true);

describe("multi-select answers with a typed addition", () => {
  it.each([true, false])(
    "submits selected options and the addition (type first: %s)",
    (typeFirst) => {
      const combined = typeFirst
        ? togglePendingUserInputOptionSelection(areas, typeAnswer(undefined, typed), "Server")
        : typeAnswer(togglePendingUserInputOptionSelection(areas, undefined, "Server"), typed);
      const both = togglePendingUserInputOptionSelection(areas, combined, "Web");

      expect(derivePendingUserInputProgress([areas], { areas: both }, 0)).toMatchObject({
        selectedOptionValues: ["Server", "Web"],
        customAnswer: typed,
        resolvedAnswer: ["Server", "Web", typed.trim()],
        canAdvance: true,
      });

      const customOnly = togglePendingUserInputOptionSelection(
        areas,
        togglePendingUserInputOptionSelection(areas, both, "Server"),
        "Web",
      );
      expect(buildPendingUserInputAnswers([areas], { areas: customOnly })).toEqual({
        areas: [typed.trim()],
      });
      expect(buildPendingUserInputAnswers([areas], { areas: typeAnswer(both, "  ") })).toEqual({
        areas: ["Server", "Web"],
      });
      expect(
        buildPendingUserInputAnswers([areas], { areas: typeAnswer(customOnly, "") }),
      ).toBeNull();
    },
  );

  it("does not repeat an addition that matches a selected option", () => {
    const draft = typeAnswer(
      togglePendingUserInputOptionSelection(areas, undefined, "Web"),
      " Web ",
    );
    expect(buildPendingUserInputAnswers([areas], { areas: draft })).toEqual({ areas: ["Web"] });
  });
});

describe("multi-select drafts", () => {
  const request = JSON.stringify(["env-1", "thread-1", "request-a"]);

  beforeEach(() => {
    usePendingUserInputDrafts.setState({ answersByRequestKey: {}, questionIndexByRequestKey: {} });
  });

  it("keeps the addition when moving between questions", () => {
    updatePendingUserInputAnswer(request, areas.id, (draft) =>
      togglePendingUserInputOptionSelection(areas, draft, "Server"),
    );
    updatePendingUserInputAnswer(request, areas.id, (draft) => typeAnswer(draft, "Mobile too"));
    setPendingUserInputQuestionIndex(request, 1);
    updatePendingUserInputAnswer(request, ttl.id, (draft) =>
      togglePendingUserInputOptionSelection(ttl, draft, "1 hour"),
    );
    setPendingUserInputQuestionIndex(request, 0);
    updatePendingUserInputAnswer(request, areas.id, (draft) =>
      togglePendingUserInputOptionSelection(areas, draft, "Web"),
    );

    const drafts = usePendingUserInputDrafts.getState().answersByRequestKey[request] ?? {};
    expect(buildPendingUserInputAnswers([areas, ttl], drafts)).toEqual({
      areas: ["Server", "Web", "Mobile too"],
      ttl: "1 hour",
    });
  });
});
