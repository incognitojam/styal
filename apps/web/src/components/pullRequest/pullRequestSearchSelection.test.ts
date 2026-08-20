import { describe, expect, it, vi } from "vite-plus/test";

import {
  readPullRequestSearchSelection,
  restorePullRequestSearchSelection,
} from "./pullRequestSearchSelection";

describe("pull request search selection", () => {
  it("preserves a mid-query selection and its direction across inputs", () => {
    const selection = readPullRequestSearchSelection({
      value: "label:bug",
      selectionStart: 2,
      selectionEnd: 7,
      selectionDirection: "backward",
    });
    const setSelectionRange = vi.fn();

    restorePullRequestSearchSelection({ value: "label:bug", setSelectionRange }, selection);

    expect(setSelectionRange).toHaveBeenCalledWith(2, 7, "backward");
  });

  it("bounds a saved selection when the receiving value is shorter", () => {
    const setSelectionRange = vi.fn();

    restorePullRequestSearchSelection(
      { value: "bug", setSelectionRange },
      { start: 5, end: 9, direction: "none" },
    );

    expect(setSelectionRange).toHaveBeenCalledWith(3, 3, "none");
  });

  it("places the caret at the end when no selection was captured", () => {
    const setSelectionRange = vi.fn();

    restorePullRequestSearchSelection({ value: "label:bug", setSelectionRange }, null);

    expect(setSelectionRange).toHaveBeenCalledWith(9, 9);
  });
});
