import type {
  ThreadPullRequestLink,
  ThreadPullRequestSnapshot,
  ThreadPullRequestStack,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createPullRequestAnnouncementTracker,
  pullRequestAnnouncementText,
} from "./pullRequestAnnouncements.ts";

let syncs = 0;
const pad = (value: number) => String(value).padStart(2, "0");
const syncedAt = (second: number) =>
  `2026-01-01T${pad(Math.floor(second / 3600))}:${pad(Math.floor(second / 60) % 60)}:${pad(second % 60)}.000Z`;
function snapshot(input: Partial<ThreadPullRequestSnapshot> = {}): ThreadPullRequestSnapshot {
  return {
    state: "open",
    title: "Change",
    headBranch: "feature",
    baseBranch: "main",
    isDraft: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    // Each sync is newer than the last, as the host sweep produces them.
    syncedAt: syncedAt(++syncs),
    checksState: "pending",
    mergeability: "mergeable",
    reviewDecision: null,
    autoMergeEnabled: false,
    ...input,
  };
}

function link(
  number: number,
  input: Partial<ThreadPullRequestSnapshot> = {},
  extra: Partial<Omit<ThreadPullRequestLink, "number">> = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "acme/rail",
    number,
    url: `https://github.com/acme/rail/pull/${number}`,
    source: "manual",
    linkedAt: "2026-01-01T00:00:00.000Z",
    snapshot: snapshot(input),
    stack: null,
    ...extra,
  };
}

/** What each successive read of one live environment announces. */
function announce(...reads: ReadonlyArray<ReadonlyArray<ThreadPullRequestLink>>) {
  const track = createPullRequestAnnouncementTracker();
  return reads.map((links) =>
    track([{ environmentId: "env", live: true, links }]).announcements.map(
      ({ number, kind }) => `#${number} ${kind}`,
    ),
  );
}

describe("createPullRequestAnnouncementTracker", () => {
  it("records a baseline on first sight instead of replaying existing states", () => {
    expect(announce([link(1, { state: "merged" }), link(2, { checksState: "failing" })])).toEqual([
      [],
    ]);
  });

  it("announces each blocker as it appears and the final state as it settles", () => {
    expect(
      announce(
        [link(1)],
        [link(1, { checksState: "failing" })],
        [link(1, { checksState: "failing", mergeability: "conflicting" })],
        [link(1, { checksState: "passing", reviewDecision: "changes-requested" })],
        [link(1, { checksState: "passing", state: "closed" })],
      ),
    ).toEqual([
      [],
      ["#1 ci-failure"],
      ["#1 merge-conflict"],
      ["#1 changes-requested"],
      ["#1 cancelled"],
    ]);
  });

  it("repeats nothing while a state holds", () => {
    expect(
      announce(
        [link(1)],
        [link(1, { checksState: "failing" })],
        [link(1, { checksState: "failing" })],
      ),
    ).toEqual([[], ["#1 ci-failure"], []]);
  });

  describe("ready to depart", () => {
    it("plays when checks pass and only a person stands in the way", () => {
      expect(announce([link(1)], [link(1, { checksState: "passing" })])).toEqual([
        [],
        ["#1 ready"],
      ]);
    });

    it("plays when the last blocker clears", () => {
      expect(
        announce(
          [link(1, { checksState: "passing", reviewDecision: "changes-requested" })],
          [link(1, { checksState: "passing", reviewDecision: "approved" })],
        ),
      ).toEqual([[], ["#1 ready"]]);
      expect(
        announce(
          [link(1, { checksState: "passing", isDraft: true })],
          [link(1, { checksState: "passing" })],
        ),
      ).toEqual([[], ["#1 ready"]]);
      expect(
        announce(
          [link(1, { checksState: "passing", autoMergeEnabled: true })],
          [link(1, { checksState: "passing", autoMergeEnabled: false })],
        ),
      ).toEqual([[], ["#1 ready"]]);
    });

    it("stays silent for a PR that will merge on its own, which is announced on arrival", () => {
      expect(
        announce(
          [link(1, { autoMergeEnabled: true })],
          [link(1, { checksState: "passing", autoMergeEnabled: true })],
          [link(1, { checksState: "passing", autoMergeEnabled: true, state: "merged" })],
        ),
      ).toEqual([[], [], ["#1 arrived"]]);
      expect(
        announce(
          [link(1, { inMergeQueue: true })],
          [link(1, { checksState: "passing", inMergeQueue: true })],
          [link(1, { checksState: "passing", inMergeQueue: false, state: "merged" })],
        ),
      ).toEqual([[], [], ["#1 arrived"]]);
    });

    it("treats a host that does not report auto-merge as not armed", () => {
      expect(
        announce(
          [link(1, { autoMergeEnabled: undefined })],
          [link(1, { checksState: "passing", autoMergeEnabled: undefined })],
        ),
      ).toEqual([[], ["#1 ready"]]);
    });
  });

  it("holds a stacked PR behind its open lower layer, then calls it ready once that merges", () => {
    const stack = (lower: "open" | "merged"): ThreadPullRequestStack => ({
      kind: "native",
      id: "stack",
      number: 1,
      url: "https://github.com/acme/rail/stacks/1",
      base: "main",
      layers: [
        { number: 10, headBranch: "lower", state: lower },
        { number: 11, headBranch: "upper", state: "open" },
      ],
    });
    expect(
      announce(
        [link(11, {}, { stack: stack("open") })],
        [link(11, { checksState: "passing" }, { stack: stack("open") })],
        [link(11, { checksState: "passing" }, { stack: stack("merged") })],
      ),
    ).toEqual([[], ["#11 stack-delayed"], ["#11 ready"]]);
  });

  describe("merge queue", () => {
    const queued = (input: Partial<ThreadPullRequestSnapshot> = {}) =>
      link(1, { checksState: "passing", inMergeQueue: true, ...input });

    it("announces leaving the queue without merging once, in place of ready", () => {
      expect(
        announce([queued()], [queued({ inMergeQueue: false })], [queued({ inMergeQueue: false })]),
      ).toEqual([[], ["#1 queue-failure"], []]);
    });

    it("forgets the ejection when the PR re-queues or is pushed to again", () => {
      expect(
        announce(
          [queued()],
          [queued({ inMergeQueue: false })],
          [queued()],
          [queued({ inMergeQueue: false, state: "merged" })],
        ),
      ).toEqual([[], ["#1 queue-failure"], [], ["#1 arrived"]]);
      expect(
        announce(
          [queued()],
          [queued({ inMergeQueue: false })],
          [queued({ inMergeQueue: false, checksState: "pending" })],
          [queued({ inMergeQueue: false })],
        ),
      ).toEqual([[], ["#1 queue-failure"], [], ["#1 ready"]]);
    });

    it("names a conflict rather than the queue when that is why it left", () => {
      expect(
        announce([queued()], [queued({ inMergeQueue: false, mergeability: "conflicting" })]),
      ).toEqual([[], ["#1 merge-conflict"]]);
    });

    it("keeps the last known queue state when a read stops reporting it", () => {
      expect(announce([queued()], [queued({ inMergeQueue: undefined })])).toEqual([[], []]);
    });
  });

  it("keeps a known blocker when a read comes back without that field", () => {
    expect(
      announce(
        [link(1)],
        [link(1, { checksState: "failing" })],
        [link(1, { checksState: undefined, mergeability: "unknown" })],
      ),
    ).toEqual([[], ["#1 ci-failure"], []]);
  });

  it("announces a PR linked from two environments once, from its newest copy", () => {
    const track = createPullRequestAnnouncementTracker();
    const read = (local: ThreadPullRequestLink, remote: ThreadPullRequestLink) =>
      track([
        { environmentId: "local", live: true, links: [local] },
        { environmentId: "remote", live: true, links: [remote] },
      ]).announcements.map(({ number, kind }) => `#${number} ${kind}`);
    const stale = link(1);
    expect(read(stale, link(1))).toEqual([]);
    expect(read(stale, link(1, { state: "merged" }))).toEqual(["#1 arrived"]);
  });

  it("stays silent across a reconnect and for links that are dismissed or not yet synced", () => {
    const track = createPullRequestAnnouncementTracker();
    const read = (live: boolean, links: ReadonlyArray<ThreadPullRequestLink>) =>
      track([{ environmentId: "env", live, links }]).announcements;
    expect(read(true, [link(1)])).toEqual([]);
    expect(read(false, [link(1)])).toEqual([]);
    // The PR changed while disconnected; reconnecting only records the new baseline.
    expect(read(true, [link(1, { state: "merged" })])).toEqual([]);
    expect(
      read(true, [
        link(2, { state: "merged" }, { source: "stack-dismissed" }),
        { ...link(3), snapshot: null },
      ]),
    ).toEqual([]);
  });

  it("keeps a reconnecting environment's PRs at their last status until it is live again", () => {
    const track = createPullRequestAnnouncementTracker();
    const read = (live: boolean, links: ReadonlyArray<ThreadPullRequestLink>) =>
      track([{ environmentId: "env", live, links }]);
    read(true, [link(1)]);
    expect(read(true, [link(1, { checksState: "failing" })]).announcements).toHaveLength(1);
    // Returning to the tab re-establishes the connection; what is playing must not read as stale.
    expect([...read(false, []).current]).toEqual([[expect.any(String), "ci-failure"]]);
    expect([...read(false, []).current]).toEqual([[expect.any(String), "ci-failure"]]);
    expect(read(true, []).current.size).toBe(0);
  });

  it("reports each PR's current announcement so stale queued ones can be dropped", () => {
    const track = createPullRequestAnnouncementTracker();
    track([{ environmentId: "env", live: true, links: [link(1)] }]);
    const { current } = track([
      { environmentId: "env", live: true, links: [link(1, { checksState: "failing" })] },
    ]);
    expect([...current.values()]).toEqual(["ci-failure"]);
  });
});

describe("pullRequestAnnouncementText", () => {
  it("writes the number as a PR reference and leads a cancellation with the apology", () => {
    expect(pullRequestAnnouncementText(831, "ready")).toBe(
      "Pull request #831 is ready to depart. It is awaiting a member of train crew.",
    );
    expect(pullRequestAnnouncementText(831, "cancelled")).toBe(
      "We are sorry to announce that pull request #831 has been cancelled.",
    );
  });
});
