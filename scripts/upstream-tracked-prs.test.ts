import { assert, describe, it } from "@effect/vitest";
import { decodeTrackedPRs, trackedPRStatuses } from "./upstream-tracked-prs.ts";
import type { QueueEntry } from "./upstream-queue.ts";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const mergedAt = "2026-09-01T00:00:00Z";

const metadata = (number: number, commit: number) => ({
  number,
  title: `Change ${number}`,
  state: "MERGED" as const,
  mergedAt,
  mergeCommit: { oid: sha(commit) },
});

const entry = (
  number: number,
  commit: number,
  disposition: QueueEntry["disposition"],
): QueueEntry => ({
  ...metadata(number, commit),
  sha: sha(commit),
  parents: [],
  empty: false,
  pr: number,
  evidence: [],
  disposition,
});

describe("tracked upstream PR report", () => {
  it("requires each tracked entry to be a unique PR number with a reason", () => {
    const decode = (entries: unknown[]) =>
      decodeTrackedPRs(JSON.stringify({ pullRequests: entries }));
    assert.deepEqual(decode([{ pr: 12, reason: " Blocks a fork change " }]), [
      { number: 12, reason: "Blocks a fork change" },
    ]);
    assert.throws(() => decode([12]), "Invalid or duplicate tracked PR");
    assert.throws(() => decode([{ pr: "12", reason: "Why" }]), "Invalid or duplicate tracked PR");
    assert.throws(
      () =>
        decode([
          { pr: 12, reason: "Why" },
          { pr: 12, reason: "Why again" },
        ]),
      "Invalid or duplicate tracked PR",
    );
    assert.throws(() => decode([{ pr: 12 }]), "Tracked PR #12 needs a reason.");
    assert.throws(() => decode([{ pr: 12, reason: "  " }]), "Tracked PR #12 needs a reason.");
  });

  it("shows a pending PR's gap from the fork tip across the target and respects recorded intake evidence", () => {
    const tracked = [11, 12, 13, 14, 15].map((number) => ({ number, reason: `Reason ${number}` }));
    const result = trackedPRStatuses({
      tracked,
      metadata: [
        metadata(11, 1),
        metadata(12, 2),
        metadata(13, 3),
        metadata(14, 4),
        metadata(15, 5),
      ],
      entries: [entry(11, 1, "pending"), entry(12, 2, "recorded")],
      forkCommits: [{ sha: sha(20), message: "Import\n\nUpstream-PR: 13" }],
      upstreamFirstParent: new Set([sha(1), sha(2), sha(3), sha(4), sha(5)]),
      targetFirstParent: new Set([sha(1), sha(2), sha(5)]),
      baselineFirstParent: new Set([sha(5)]),
      exceptions: {},
      tipMergedAt: Date.parse("2026-08-30T12:00:00Z"),
    });
    assert.deepEqual(
      result.map((pr) => [pr.status, pr.daysAheadOfTip, pr.beyondTarget]),
      [
        ["pending", 1.5, false],
        ["recorded", null, false],
        ["recorded", null, true],
        ["pending", 1.5, true],
        ["recorded", null, false],
      ],
    );
  });

  it("does not treat missing upstream history or an open PR as pending intake", () => {
    const result = trackedPRStatuses({
      tracked: [21, 22].map((number) => ({ number, reason: `Reason ${number}` })),
      metadata: [
        metadata(21, 1),
        { number: 22, title: "Open change", state: "OPEN", mergedAt: null, mergeCommit: null },
      ],
      entries: [],
      forkCommits: [],
      upstreamFirstParent: new Set(),
      targetFirstParent: new Set(),
      baselineFirstParent: new Set(),
      exceptions: {},
      tipMergedAt: Date.parse("2026-08-30T12:00:00Z"),
    });
    assert.deepEqual(
      result.map((pr) => pr.status),
      ["fetch upstream", "open"],
    );
  });
});
