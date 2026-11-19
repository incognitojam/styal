import { describe, expect, it } from "vite-plus/test";

import {
  answeredSince,
  defaultCopiesState,
  quickAddDecision,
} from "./AddProjectToMachineDialog.logic";

const ready = { targetAvailable: true, waitedTooLong: false } as const;

describe("quickAddDecision", () => {
  it.each([
    [0, "missing", "start"],
    ["unsupported", "missing", "ask"],
    [2, "missing", "ask"],
    [2, "loading", "ask"],
    [0, "exists", "ask"],
    ["loading", "exists", "ask"],
    ["failed", "missing", "ask"],
    [0, "failed", "ask"],
    ["loading", "missing", "wait"],
    [0, "loading", "wait"],
  ] as const)("copies %s, folder %s: %s", (defaultCopies, destination, expected) => {
    expect(quickAddDecision({ ...ready, defaultCopies, destination })).toBe(expected);
  });

  it("asks once the checks take too long, and never starts on a guess", () => {
    expect(
      quickAddDecision({
        ...ready,
        defaultCopies: "loading",
        destination: "missing",
        waitedTooLong: true,
      }),
    ).toBe("ask");
    expect(
      quickAddDecision({ ...ready, defaultCopies: 0, destination: "missing", waitedTooLong: true }),
    ).toBe("start");
  });

  it("asks rather than clone to another machine when the clicked one drops", () => {
    expect(
      quickAddDecision({
        ...ready,
        targetAvailable: false,
        defaultCopies: 0,
        destination: "missing",
      }),
    ).toBe("ask");
  });
});

describe("answeredSince", () => {
  it.each([
    [{ data: { files: [] }, dataUpdatedAt: 900, isPending: false }, false],
    [{ data: { files: [] }, dataUpdatedAt: 1_100, isPending: true }, false],
    [{ data: null, dataUpdatedAt: 0, isPending: true }, false],
    [{ data: { files: [] }, dataUpdatedAt: 1_100, isPending: false }, true],
  ])("%o after a click at 1000: %s", (query, expected) => {
    expect(answeredSince(query, 1_000)).toBe(expected);
  });
});

describe("defaultCopiesState", () => {
  const listed = { canListFiles: true, error: null, answered: true, defaultCount: 2 } as const;
  it.each([
    [{ ...listed, data: { failed: false } }, 2],
    [{ ...listed, data: { failed: true } }, "failed"],
    [{ ...listed, data: null, error: "Request failed" }, "failed"],
    [{ ...listed, data: { failed: false }, answered: false }, "loading"],
    [{ ...listed, data: null, canListFiles: false }, "unsupported"],
  ] as const)("%o: %s", (input, expected) => {
    expect(defaultCopiesState(input)).toBe(expected);
  });
});
