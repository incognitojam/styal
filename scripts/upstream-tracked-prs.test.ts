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
  it("rejects duplicate or invalid tracked entries", () => {
    assert.deepEqual(decodeTrackedPRs('{"pullRequests":[12]}'), [{ number: 12 }]);
    assert.throws(() => decodeTrackedPRs('{"pullRequests":["12"]}'));
    assert.throws(() => decodeTrackedPRs('{"pullRequests":[12,12]}'));
  });

  it("shows pending age across the target and respects recorded intake evidence", () => {
    const tracked = [11, 12, 13, 14, 15].map((number) => ({ number }));
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
      now: Date.parse("2026-09-24T00:00:00Z"),
    });
    assert.deepEqual(
      result.map((pr) => [pr.status, pr.lagDays, pr.beyondTarget]),
      [
        ["pending", 23, false],
        ["recorded", null, false],
        ["recorded", null, true],
        ["pending", 23, true],
        ["recorded", null, false],
      ],
    );
  });

  it("does not treat missing upstream history or an open PR as pending intake", () => {
    const result = trackedPRStatuses({
      tracked: [21, 22].map((number) => ({ number })),
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
      now: Date.parse("2026-09-24T00:00:00Z"),
    });
    assert.deepEqual(
      result.map((pr) => pr.status),
      ["fetch upstream", "open"],
    );
  });
});
