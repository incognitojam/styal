import { assert, describe, it } from "@effect/vitest";
import {
  assessEarlyCandidates,
  resolveEarlyDependencies,
  selectEarlySources,
} from "./upstream-early.ts";
import type { QueueEntry } from "./upstream-queue.ts";

const entry = (
  n: number,
  pr: number | null,
  disposition: QueueEntry["disposition"] = "pending",
): QueueEntry => ({
  sha: String(n),
  parents: [String(n - 1)],
  title: `change ${n}`,
  empty: false,
  pr,
  evidence: [],
  disposition,
});

describe("early upstream intake assessment", () => {
  it("flags pending direct commits and PRs that touch a candidate's files", () => {
    const entries = [
      entry(0, 1, "recorded"),
      entry(1, 10),
      entry(2, null),
      entry(3, 11),
      entry(4, 12),
    ];
    const paths = new Map([
      ["1", ["model.ts"]],
      ["2", ["settings.ts"]],
      ["3", ["model.ts", "settings.ts"]],
      ["4", ["mobile.ts"]],
    ]);
    const result = assessEarlyCandidates(
      entries,
      "base",
      "0",
      10,
      null,
      (source) => paths.get(source.sha) ?? [],
      (source) => source.pr !== 11,
    );
    assert.deepEqual(
      result.map(({ pr, precedingPRs, overlappingPaths, cleanApply, fileDisjointAndClean }) => ({
        pr,
        precedingPRs,
        overlappingPaths,
        cleanApply,
        fileDisjointAndClean,
      })),
      [
        {
          pr: 10,
          precedingPRs: 0,
          overlappingPaths: [],
          cleanApply: true,
          fileDisjointAndClean: true,
        },
        {
          pr: 11,
          precedingPRs: 1,
          overlappingPaths: ["model.ts", "settings.ts"],
          cleanApply: false,
          fileDisjointAndClean: false,
        },
        {
          pr: 12,
          precedingPRs: 2,
          overlappingPaths: [],
          cleanApply: true,
          fileDisjointAndClean: true,
        },
      ],
    );
  });

  it("does not claim clean application for a multi-commit PR", () => {
    const entries = [entry(0, 1, "recorded"), entry(1, 10), entry(2, 10)];
    const result = assessEarlyCandidates(
      entries,
      "base",
      "0",
      1,
      10,
      () => ["model.ts"],
      () => {
        throw new Error("should not simulate one commit in isolation");
      },
    );
    assert.equal(result[0]!.cleanApply, null);
    assert.match(result[0]!.reason!, /Multi-commit/);
    assert.deepEqual(result[0]!.overlappingPaths, []);
  });

  it("rejects a PR outside the pending range", () => {
    assert.throws(
      () =>
        assessEarlyCandidates(
          [entry(0, 1, "recorded")],
          "base",
          "0",
          10,
          10,
          () => [],
          () => true,
        ),
      "not pending",
    );
  });

  it("flags a file and directory at the same path as overlapping", () => {
    const result = assessEarlyCandidates(
      [entry(0, 1, "recorded"), entry(1, 10), entry(2, 11)],
      "base",
      "0",
      2,
      null,
      (source) => (source.pr === 10 ? ["assets"] : ["assets/logo.svg"]),
      () => true,
    );
    assert.deepEqual(result[1]!.overlappingPaths, ["assets/logo.svg"]);
    assert.equal(result[1]!.fileDisjointAndClean, false);
  });

  it("selects whole pending PRs and keeps intervening source history", () => {
    const entries = [
      entry(0, 1, "recorded"),
      entry(1, 10),
      entry(2, 11),
      entry(3, null),
      entry(4, 12),
      entry(5, 13),
    ];
    const selection = selectEarlySources(entries, "base", "0", [12, 10]);
    assert.deepEqual(
      selection.selected.map((source) => source.sha),
      ["1", "4"],
    );
    assert.deepEqual(
      selection.intervening.map((source) => source.sha),
      ["1", "2", "3", "4"],
    );
  });

  it("starts at the baseline before any entry is reconciled", () => {
    const entries = [entry(0, 10), entry(1, 11), entry(2, 12)];
    const selection = selectEarlySources(entries, "base", "base", [11]);
    assert.deepEqual(
      selection.intervening.map((source) => source.sha),
      ["0", "1"],
    );
    assert.deepEqual(
      assessEarlyCandidates(
        entries,
        "base",
        "base",
        3,
        null,
        () => [],
        () => true,
      ).map((candidate) => candidate.pr),
      [10, 11, 12],
    );
    assert.throws(
      () => selectEarlySources(entries, "base", "elsewhere", [11]),
      "outside the upstream target",
    );
  });

  it("adds only replay conflicts and retries their upstream-order selection", () => {
    const entries = [entry(0, 1, "recorded"), entry(1, 10), entry(2, 11), entry(3, 12)];
    const plan = resolveEarlyDependencies(entries, "base", "0", [12], (selection) => {
      const selected = new Set(selection.selected.map((source) => source.pr));
      if (!selected.has(11)) return entries[2]!;
      if (!selected.has(10)) return entries[1]!;
      return null;
    });
    assert.deepEqual(plan.dependencyPRs, [11, 10]);
    assert.deepEqual(
      plan.selected.map((source) => source.sha),
      ["1", "2", "3"],
    );
    assert.equal(plan.attempts, 3);
  });
});
