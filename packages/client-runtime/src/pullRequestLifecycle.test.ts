import { describe, expect, it } from "vite-plus/test";
import type { PullRequestLifecycleEvent } from "@t3tools/contracts";
import { pullRequestLifecycleEvents, pullRequestLifecycleText } from "./pullRequestLifecycle.ts";

const merge: PullRequestLifecycleEvent = {
  id: "ME_1",
  kind: "merged",
  createdAt: "2026-10-01T12:00:00Z",
  actor: { login: "maintainer", name: null, avatarUrl: null },
  commit: { oid: "1234567890abcdef", url: "https://github.com/acme/web/commit/1234567890abcdef" },
  targetBranch: "release",
};

describe("pull request lifecycle", () => {
  it("uses the host's merge once even when detail has a different merge timestamp", () => {
    expect(
      pullRequestLifecycleEvents({
        lifecycleEvents: [merge, merge],
        mergedAt: "2026-10-02T12:00:00Z",
      }),
    ).toEqual([merge]);
    expect(pullRequestLifecycleText(merge)).toBe("merged commit 1234567 into release");
  });

  it("retains the timestamp-only fallback for older servers and unsupported hosts", () => {
    const events = pullRequestLifecycleEvents({ mergedAt: merge.createdAt });
    expect(events).toEqual([
      {
        id: "merged",
        kind: "merged",
        createdAt: merge.createdAt,
        actor: null,
        commit: null,
        targetBranch: null,
      },
    ]);
    expect(pullRequestLifecycleText(events[0]!)).toBe("Pull request merged");
    expect(pullRequestLifecycleEvents({})).toEqual([]);
    expect(pullRequestLifecycleText({ ...merge, actor: null, commit: null })).toBe(
      "merged into release",
    );
  });

  it("preserves deletion followed by restoration without asserting current branch existence", () => {
    const deletion: PullRequestLifecycleEvent = {
      id: "HDE_1",
      kind: "head-ref-deleted",
      createdAt: merge.createdAt,
      actor: null,
      branchName: "feature",
    };
    const restoration: PullRequestLifecycleEvent = {
      ...deletion,
      id: "HRE_1",
      kind: "head-ref-restored",
      createdAt: "2026-10-02T12:00:00Z",
      branchName: null,
    };
    expect(pullRequestLifecycleEvents({ lifecycleEvents: [deletion, restoration] })).toEqual([
      deletion,
      restoration,
    ]);
    expect(pullRequestLifecycleText(deletion)).toBe("deleted the feature branch");
    expect(pullRequestLifecycleText(restoration)).toBe("restored the branch");
  });
});
