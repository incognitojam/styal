import { describe, expect, it } from "vite-plus/test";

import {
  buildPendingUserInputAnswers,
  isPendingUserInputOptionSelected,
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
const typed = "  Rust instead  ";

describe("single-select questions with a custom answer draft", () => {
  it("keeps typed text in its field while submitting only the selected option", () => {
    const draft = setPendingUserInputCustomAnswer(runtime, undefined, typed);
    const selected = togglePendingUserInputOptionSelection(runtime, draft, "Go");

    expect(selected.customAnswer).toBe(typed);
    expect(isPendingUserInputOptionSelected(runtime, selected, "Go")).toBe(true);
    expect(isPendingUserInputOptionSelected(runtime, selected, "Node.js")).toBe(false);
    expect(buildPendingUserInputAnswers([runtime], { runtime: selected })).toEqual({
      runtime: "Go",
    });

    const switched = togglePendingUserInputOptionSelection(runtime, selected, "Node.js");
    const repeated = togglePendingUserInputOptionSelection(runtime, switched, "Node.js");
    expect(repeated.customAnswer).toBe(typed);
    expect(isPendingUserInputOptionSelected(runtime, repeated, "Go")).toBe(false);
    expect(isPendingUserInputOptionSelected(runtime, repeated, "Node.js")).toBe(true);
    expect(buildPendingUserInputAnswers([runtime], { runtime: repeated })).toEqual({
      runtime: "Node.js",
    });
  });

  it("reactivates the retained answer without changing its text", () => {
    const selected = togglePendingUserInputOptionSelection(
      runtime,
      setPendingUserInputCustomAnswer(runtime, undefined, typed),
      "Go",
    );
    const activated = setPendingUserInputCustomAnswer(
      runtime,
      selected,
      selected.customAnswer ?? "",
    );

    expect(activated.customAnswer).toBe(typed);
    expect(isPendingUserInputOptionSelected(runtime, activated, "Go")).toBe(false);
    expect(buildPendingUserInputAnswers([runtime], { runtime: activated })).toEqual({
      runtime: "Rust instead",
    });
  });

  it("switches back to the custom answer when the retained text is edited", () => {
    const selected = togglePendingUserInputOptionSelection(
      runtime,
      setPendingUserInputCustomAnswer(runtime, undefined, typed),
      "Go",
    );
    const edited = setPendingUserInputCustomAnswer(runtime, selected, "Rust with Tokio");

    expect(isPendingUserInputOptionSelected(runtime, edited, "Go")).toBe(false);
    expect(buildPendingUserInputAnswers([runtime], { runtime: edited })).toEqual({
      runtime: "Rust with Tokio",
    });

    const selectedAgain = togglePendingUserInputOptionSelection(runtime, edited, "Go");
    expect(selectedAgain.customAnswer).toBe("Rust with Tokio");
    expect(buildPendingUserInputAnswers([runtime], { runtime: selectedAgain })).toEqual({
      runtime: "Go",
    });
  });

  it.each(["", "   "])("clearing the custom answer (%j) also clears the option", (value) => {
    const selected = togglePendingUserInputOptionSelection(
      runtime,
      setPendingUserInputCustomAnswer(runtime, undefined, typed),
      "Go",
    );
    const cleared = setPendingUserInputCustomAnswer(runtime, selected, value);

    expect(isPendingUserInputOptionSelected(runtime, cleared, "Go")).toBe(false);
    expect(buildPendingUserInputAnswers([runtime], { runtime: cleared })).toBeNull();
  });

  it("ignores an invalid option and submits the custom answer", () => {
    const draft = setPendingUserInputCustomAnswer(runtime, undefined, typed);
    const next = togglePendingUserInputOptionSelection(runtime, draft, "unknown");

    expect(next.customAnswer).toBe(typed);
    expect(buildPendingUserInputAnswers([runtime], { runtime: next })).toEqual({
      runtime: "Rust instead",
    });
  });

  it("ignores stale option values when resolving a custom answer", () => {
    expect(
      buildPendingUserInputAnswers([runtime], {
        runtime: { selectedOptionValues: ["unknown"], customAnswer: typed },
      }),
    ).toEqual({ runtime: "Rust instead" });
  });
});
