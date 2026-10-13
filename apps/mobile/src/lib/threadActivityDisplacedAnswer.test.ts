import { describe, expect, it } from "vite-plus/test";

import {
  carryDisplacedCustomAnswerIntoDraft,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./threadActivity";

const runtime = {
  id: "runtime",
  header: "Runtime",
  question: "Which runtime should be used?",
  options: [
    { label: "Go", description: "One binary" },
    { label: "Node.js", description: "Reuse TypeScript" },
  ],
  multiSelect: false,
} as const;
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

function pickOption(
  question: typeof runtime | typeof scope,
  typed: string,
  option: string,
  draftText: string,
) {
  const previous = setPendingUserInputCustomAnswer(question, undefined, typed);
  const next = togglePendingUserInputOptionSelection(question, previous, option);
  return carryDisplacedCustomAnswerIntoDraft(draftText, previous, next);
}

describe("typed answers replaced by an option", () => {
  it("moves a single-select answer into an empty thread draft", () => {
    expect(pickOption(runtime, "  Rust instead  ", "Go", "")).toBe("Rust instead");
  });

  it("appends it after text already waiting in the thread draft", () => {
    expect(pickOption(runtime, "Rust instead", "Go", "Check the tests first\n")).toBe(
      "Check the tests first\n\nRust instead",
    );
  });

  it("leaves the thread draft alone when nothing was typed", () => {
    expect(pickOption(runtime, "   ", "Go", "Check the tests first")).toBe("Check the tests first");
  });

  it("leaves the thread draft alone when a multi-select answer keeps the text", () => {
    expect(pickOption(scope, "Include shipment tracking", "Orders", "")).toBe("");
  });
});
