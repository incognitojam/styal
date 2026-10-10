import { assert, describe, it } from "@effect/vitest";
import { decodeTrackedPRs, snapshotTrackingErrors, trackedPRStatuses } from "./tracked-prs.ts";
import type { QueueEntry } from "../queue.ts";
import { renderTrackedPRReport } from "../tracked-prs-report.ts";

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

  it("validates frozen snapshot revisions without changing ordinary watch entries", () => {
    const decode = (snapshot: unknown) =>
      decodeTrackedPRs(
        JSON.stringify({ pullRequests: [{ pr: 12, reason: "Reconcile", snapshot }] }),
      );
    assert.deepEqual(decode({ base: sha(1), head: sha(2) })[0]!.snapshot, {
      base: sha(1),
      head: sha(2),
    });
    for (const snapshot of [
      null,
      {},
      { head: sha(2) },
      { base: sha(1), head: "short" },
      { base: sha(1), head: "A".repeat(40) },
      { base: sha(1), head: sha(1) },
    ]) {
      assert.throws(() => decode(snapshot), "snapshot base and head SHAs");
    }
  });

  it("requires a provisional marker for unmerged PR provenance and explicit cleanup provenance", () => {
    const tracked = [{ number: 11, reason: "Reconcile", snapshot: { base: sha(0), head: sha(9) } }];
    const open = { ...metadata(11, 1), state: "OPEN" as const, mergedAt: null, mergeCommit: null };
    assert.include(
      snapshotTrackingErrors({ tracked: [], previous: [], sourcePRs: [11], metadata: [open] }).join(
        "\n",
      ),
      "needs a provisional snapshot",
    );
    assert.deepEqual(
      snapshotTrackingErrors({ tracked, previous: [], sourcePRs: [11], metadata: [open] }),
      [],
    );
    assert.include(
      snapshotTrackingErrors({ tracked: [], previous: tracked, sourcePRs: [], metadata: [] }).join(
        "\n",
      ),
      "needs its Upstream-PR provenance",
    );
    assert.deepEqual(
      snapshotTrackingErrors({
        tracked: [],
        previous: tracked,
        sourcePRs: [11],
        metadata: [metadata(11, 1)],
      }),
      [],
    );
    assert.deepEqual(
      snapshotTrackingErrors({
        tracked: [],
        previous: tracked,
        sourcePRs: [11],
        metadata: [{ ...open, state: "CLOSED" }],
      }),
      [],
    );
  });

  it("shows provisional open and closed imports and never marks a merged snapshot recorded", () => {
    const tracked = [11, 12, 13, 14].map((number) => ({
      number,
      reason: "Review final outcome",
      snapshot: { base: sha(0), head: sha(9) },
    }));
    const input = {
      tracked,
      metadata: [
        { ...metadata(11, 1), state: "OPEN" as const, mergedAt: null, mergeCommit: null },
        { ...metadata(12, 2), state: "CLOSED" as const, mergedAt: null, mergeCommit: null },
        metadata(13, 3),
        metadata(14, 4),
      ],
      entries: [],
      forkCommits: [{ sha: sha(20), message: "Upstream-PR: 13, 14" }],
      upstreamFirstParent: new Set([sha(3)]),
      targetFirstParent: new Set([sha(3)]),
      baselineFirstParent: new Set([sha(3)]),
      exceptions: {},
      tipMergedAt: Date.parse(mergedAt),
    };
    const statuses = trackedPRStatuses(input);
    assert.deepEqual(
      statuses.map((pr) => pr.status),
      ["open", "review closed import", "pending", "fetch upstream"],
    );
    const report = renderTrackedPRReport("example/upstream", statuses);
    assert.include(report, "review closed import");
    assert.include(report, `snapshot ${sha(9).slice(0, 10)} (provisional)`);
    assert.equal(
      trackedPRStatuses({
        ...input,
        tracked: tracked.map(({ number, reason }) => ({ number, reason })),
      })[2]!.status,
      "recorded",
    );
    assert.equal(
      trackedPRStatuses({
        ...input,
        exceptions: { [sha(3)]: { disposition: "skip" as const } },
      })[2]!.status,
      "skipped",
    );
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
