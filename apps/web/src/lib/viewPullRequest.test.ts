import { ProjectId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadPullRequestUrl } from "./viewPullRequest";

const url = (number: number) => `https://github.com/owner/repo/pull/${number}`;

const single = (number: number) => ({
  projectId: ProjectId.make("project"),
  repository: "owner/repo",
  number,
  url: url(number),
});

const link = (number: number): ThreadPullRequestLink => ({
  host: "github.com",
  repository: "owner/repo",
  number,
  url: url(number),
  source: "manual",
  linkedAt: "2026-11-01T00:00:00Z",
  snapshot: null,
  stack: null,
});

describe("threadPullRequestUrl", () => {
  const thread = { linkedPullRequest: single(3), branchPullRequest: single(4) };

  it("prefers a linked pull request where the environment tracks several", () => {
    expect(threadPullRequestUrl({ ...thread, pullRequests: [link(2)] }, true)).toBe(url(2));
  });

  it("falls back to the branch pull request, ignoring the older single link", () => {
    expect(threadPullRequestUrl(thread, true)).toBe(url(4));
  });

  it("uses the older single link on environments without linked pull requests", () => {
    expect(threadPullRequestUrl({ ...thread, pullRequests: [link(2)] }, false)).toBe(url(3));
  });

  it("finds nothing for a thread without a pull request", () => {
    expect(threadPullRequestUrl({}, true)).toBeNull();
  });
});
