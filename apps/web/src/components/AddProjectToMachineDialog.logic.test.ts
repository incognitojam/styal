import { describe, expect, it } from "vite-plus/test";

import { quickAddDecision } from "./AddProjectToMachineDialog.logic";

describe("quickAddDecision", () => {
  it.each([
    [0, "missing", "start"],
    ["unsupported", "missing", "start"],
    [2, "missing", "ask"],
    [2, "loading", "ask"],
    [0, "exists", "ask"],
    ["loading", "exists", "ask"],
    ["failed", "missing", "ask"],
    [0, "failed", "ask"],
    ["loading", "missing", "wait"],
    [0, "loading", "wait"],
  ] as const)("copies %s, folder %s: %s", (defaultCopies, destination, expected) => {
    expect(quickAddDecision({ defaultCopies, destination, waitedTooLong: false })).toBe(expected);
  });

  it("asks once the checks take too long, and never starts on a guess", () => {
    expect(
      quickAddDecision({ defaultCopies: "loading", destination: "missing", waitedTooLong: true }),
    ).toBe("ask");
    expect(
      quickAddDecision({ defaultCopies: 0, destination: "missing", waitedTooLong: true }),
    ).toBe("start");
  });
});
