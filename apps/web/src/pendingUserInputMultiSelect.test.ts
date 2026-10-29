import { derivePendingUserInputProgress } from "./pendingUserInput";
import type { ThreadUserInputQuestion as UserInputQuestion } from "@t3tools/client-runtime/state/thread-requests";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";

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
const typeAnswer = (draft: PendingUserInputDraftAnswer | undefined, text: string) =>
  setPendingUserInputCustomAnswer(areas, draft, text);

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
  it("keeps the addition when another question is answered in between", () => {
    let drafts: Record<string, PendingUserInputDraftAnswer> = {};
    drafts = {
      ...drafts,
      areas: togglePendingUserInputOptionSelection(areas, drafts.areas, "Server"),
    };
    drafts = { ...drafts, areas: typeAnswer(drafts.areas, "Mobile too") };
    drafts = { ...drafts, ttl: togglePendingUserInputOptionSelection(ttl, drafts.ttl, "1 hour") };
    drafts = {
      ...drafts,
      areas: togglePendingUserInputOptionSelection(areas, drafts.areas, "Web"),
    };

    expect(buildPendingUserInputAnswers([areas, ttl], drafts)).toEqual({
      areas: ["Server", "Web", "Mobile too"],
      ttl: "1 hour",
    });
  });
});
