import { describe, expect, it } from "vite-plus/test";

import {
  buildPendingUserInputAnswers,
  isPendingUserInputOptionSelected,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./threadActivity";

const scope = {
  id: "scope",
  header: "Scope",
  question: "Which data should be collected?",
  options: [
    { label: "Orders", description: "Receipts" },
    { label: "Listings", description: "Inventory" },
  ],
  multiSelect: true,
} as const;
const typed = "  Include shipment tracking  ";

describe("multi-select answers with a typed addition", () => {
  it.each([true, false])(
    "keeps the addition with selected options (type first: %s)",
    (typeFirst) => {
      const combined = typeFirst
        ? togglePendingUserInputOptionSelection(
            scope,
            setPendingUserInputCustomAnswer(scope, undefined, typed),
            "Orders",
          )
        : setPendingUserInputCustomAnswer(
            scope,
            togglePendingUserInputOptionSelection(scope, undefined, "Orders"),
            typed,
          );
      const both = togglePendingUserInputOptionSelection(scope, combined, "Listings");

      expect(isPendingUserInputOptionSelected(scope, both, "Orders")).toBe(true);
      expect(isPendingUserInputOptionSelected(scope, both, "Listings")).toBe(true);
      expect(buildPendingUserInputAnswers([scope], { scope: both })).toEqual({
        scope: ["Orders", "Listings", typed.trim()],
      });

      const customOnly = togglePendingUserInputOptionSelection(
        scope,
        togglePendingUserInputOptionSelection(scope, both, "Orders"),
        "Listings",
      );
      expect(buildPendingUserInputAnswers([scope], { scope: customOnly })).toEqual({
        scope: [typed.trim()],
      });
      expect(
        buildPendingUserInputAnswers([scope], {
          scope: setPendingUserInputCustomAnswer(scope, both, "  "),
        }),
      ).toEqual({ scope: ["Orders", "Listings"] });
      expect(
        buildPendingUserInputAnswers([scope], {
          scope: setPendingUserInputCustomAnswer(scope, customOnly, ""),
        }),
      ).toBeNull();
    },
  );

  it("does not repeat an addition that matches a selected option", () => {
    expect(
      buildPendingUserInputAnswers([scope], {
        scope: { selectedOptionValues: ["Orders", "Listings"], customAnswer: " Listings " },
      }),
    ).toEqual({ scope: ["Orders", "Listings"] });
  });
});
