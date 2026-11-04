import {
  ProjectId,
  type ThreadLinkedPullRequest,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadPullRequestUrl } from "./viewPullRequest";

const url = (number: number) => `https://github.com/owner/repo/pull/${number}`;

const linked = (number: number): ThreadLinkedPullRequest => ({
  projectId: ProjectId.make("project"),
  repository: "owner/repo",
  number,
  url: url(number),
});

const link = (number: number, state: "open" | "merged"): ThreadPullRequestLink => ({
  host: "github.com",
  repository: "owner/repo",
  number,
  url: url(number),
  source: "manual",
  linkedAt: "2026-11-01T00:00:00Z",
  snapshot: {
    state,
    title: `PR ${number}`,
    headBranch: `branch-${number}`,
    baseBranch: "main",
    isDraft: false,
    updatedAt: null,
    syncedAt: "2026-11-01T00:00:00Z",
  },
  stack: null,
});

describe("threadPullRequestUrl", () => {
  it("prefers the open linked pull request where the environment tracks several", () => {
    const thread = {
      pullRequests: [link(1, "merged"), link(2, "open")],
      linkedPullRequest: linked(3),
      branchPullRequest: linked(4),
    };
    expect(threadPullRequestUrl(thread, true)).toBe(url(2));
  });

  it("falls back to the branch pull request, ignoring the legacy single link", () => {
    expect(
      threadPullRequestUrl({ linkedPullRequest: linked(3), branchPullRequest: linked(4) }, true),
    ).toBe(url(4));
  });

  it("uses the legacy single link on environments without linked pull requests", () => {
    const thread = {
      pullRequests: [link(2, "open")],
      linkedPullRequest: linked(3),
      branchPullRequest: linked(4),
    };
    expect(threadPullRequestUrl(thread, false)).toBe(url(3));
    expect(threadPullRequestUrl({ branchPullRequest: linked(4) }, false)).toBe(url(4));
  });

  it("finds nothing for a thread without a pull request", () => {
    expect(threadPullRequestUrl({}, true)).toBeNull();
    expect(threadPullRequestUrl({ pullRequests: [], branchPullRequest: null }, false)).toBeNull();
  });
});
