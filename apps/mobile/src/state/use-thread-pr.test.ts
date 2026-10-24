import { ProjectId, type ThreadPullRequestLink, type VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  presentThreadLinkedPullRequests,
  presentThreadPr,
  resolveThreadPrSource,
} from "./thread-pr-presentation";

const pullRequest: NonNullable<VcsStatusResult["pr"]> = {
  number: 3774,
  title: "Desktop-style pull request indicator",
  url: "https://github.com/t3tools/t3code/pull/3774",
  baseRef: "main",
  headRef: "codex/desktop-style-pr-indicator",
  state: "merged",
};

describe("presentThreadPr", () => {
  it("announces merge intent without changing the open color, and ignores stale terminal intent", () => {
    expect(
      presentThreadPr({ ...pullRequest, state: "open", autoMergeEnabled: true }, undefined),
    ).toMatchObject({
      mergeIntent: "auto-merge",
      accessibilityLabel: "#3774 pull request open, Auto-merge enabled",
      textClassName: "text-adaptive-emerald-600-400",
    });
    expect(
      presentThreadPr({ ...pullRequest, state: "open", inMergeQueue: true }, undefined),
    ).toMatchObject({
      mergeIntent: "queued",
      accessibilityLabel: "#3774 pull request open, In merge queue",
    });
    expect(
      presentThreadPr({ ...pullRequest, autoMergeEnabled: true, inMergeQueue: true }, undefined),
    ).not.toHaveProperty("mergeIntent");
  });
});

function linkedPr(
  number: number,
  overrides: Partial<ThreadPullRequestLink> = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "t3tools/t3code",
    number,
    url: `https://github.com/t3tools/t3code/pull/${number}`,
    source: "manual",
    linkedAt: "2026-09-08T00:00:00.000Z",
    stack: null,
    snapshot: {
      state: "open",
      title: `Change ${number}`,
      headBranch: `change-${number}`,
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-09-08T00:00:00.000Z",
    },
    ...overrides,
  };
}

describe("presentThreadLinkedPullRequests", () => {
  it("marks linked counts only when every remaining PR has merge intent", () => {
    const first = linkedPr(1);
    const second = linkedPr(2);
    const armed = { ...first, snapshot: { ...first.snapshot!, autoMergeEnabled: true } };
    expect(presentThreadLinkedPullRequests([armed, second])).not.toHaveProperty("mergeIntent");
    const queued = { ...second, snapshot: { ...second.snapshot!, inMergeQueue: true } };
    expect(presentThreadLinkedPullRequests([armed, queued])).toMatchObject({
      mergeIntent: "auto-merge",
      label: "+2",
      accessibilityLabel:
        "2 linked pull requests, overall open, all remaining pull requests awaiting merge",
    });
  });

  it("uses the top of a derived stack even when its bottom was linked later", () => {
    const bottom = linkedPr(1, { linkedAt: "2026-09-09T00:00:00.000Z" });
    const top = linkedPr(2);
    expect(
      presentThreadLinkedPullRequests([
        bottom,
        {
          ...top,
          snapshot: { ...top.snapshot!, baseBranch: "change-1" },
        },
      ]),
    ).toMatchObject({ kind: "stack", label: "2", number: 2, url: top.url });
  });

  it("names a single link with its host's term", () => {
    expect(presentThreadLinkedPullRequests([linkedPr(7)])?.accessibilityLabel).toBe(
      "#7 pull request open",
    );
    expect(
      presentThreadLinkedPullRequests([
        linkedPr(7, {
          host: "gitlab.com",
          repository: "t3tools/t3code",
          url: "https://gitlab.com/t3tools/t3code/-/merge_requests/7",
        }),
      ])?.accessibilityLabel,
    ).toBe("#7 merge request open");
  });
});

describe("resolveThreadPrSource compatibility", () => {
  const legacyRef = {
    projectId: ProjectId.make("project"),
    repository: "t3tools/t3code",
    number: 1,
    url: "https://github.com/t3tools/t3code/pull/1",
  };
  const branchRef = { ...legacyRef, number: 2, url: "https://github.com/t3tools/t3code/pull/2" };

  it("polls the legacy reference when only the older linking capability exists", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        { threadPullRequestLinking: true },
      ),
    ).toEqual({ linkedPresentation: null, pullRequestRef: legacyRef });
  });

  it("ignores stale snapshots after reconnecting to a server without array support", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [linkedPr(3)], linkedPullRequest: legacyRef },
        { threadPullRequestLinking: true, threadPullRequests: false },
      ),
    ).toEqual({ linkedPresentation: null, pullRequestRef: legacyRef });
  });

  it("uses snapshots without polling when both capabilities are advertised", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [linkedPr(3)], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        { threadPullRequestLinking: true, threadPullRequests: true },
      ),
    ).toMatchObject({ linkedPresentation: { number: 3 }, pullRequestRef: null });
  });

  it("does not revive a removed modern link from the compatibility reference", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        { threadPullRequests: true },
      ),
    ).toEqual({ linkedPresentation: null, pullRequestRef: branchRef });
  });

  it("does not poll when a modern link is waiting for its first snapshot", () => {
    expect(
      resolveThreadPrSource(
        {
          pullRequests: [linkedPr(3, { snapshot: null })],
          linkedPullRequest: legacyRef,
          branchPullRequest: branchRef,
        },
        { threadPullRequests: true },
      ),
    ).toMatchObject({ linkedPresentation: { number: 3, state: null }, pullRequestRef: null });
  });
});
