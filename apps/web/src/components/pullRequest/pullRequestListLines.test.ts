import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { resolveThreadPullRequestChains } from "@t3tools/shared/threadPullRequests";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestListLines } from "./pullRequestListLines";

function link(
  number: number,
  head: string,
  base: string,
  updatedAt: string,
  stack: ThreadPullRequestLink["stack"] = null,
  snapshot: Partial<NonNullable<ThreadPullRequestLink["snapshot"]>> = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "acme/web",
    number,
    url: `https://github.com/acme/web/pull/${number}`,
    source: "manual",
    linkedAt: "2026-01-01T00:00:00.000Z",
    snapshot: {
      state: "open",
      title: `PR ${number}`,
      headBranch: head,
      baseBranch: base,
      isDraft: false,
      updatedAt,
      syncedAt: updatedAt,
      ...snapshot,
    },
    stack,
  };
}

describe("pullRequestListLines", () => {
  it("puts open, draft, and unsynced work before newer completed PRs", () => {
    const unsynced = {
      ...link(3, "pending", "main", "2026-01-01T10:00:00Z"),
      linkedAt: "2026-01-01T10:00:00Z",
      snapshot: null,
    };
    const lines = pullRequestListLines(
      resolveThreadPullRequestChains([
        link(5, "merged", "main", "2026-01-02T12:00:00Z", null, { state: "merged" }),
        link(4, "closed", "main", "2026-01-02T11:00:00Z", null, { state: "closed" }),
        link(1, "active", "main", "2026-01-01T08:00:00Z"),
        link(2, "draft", "main", "2026-01-01T09:00:00Z", null, { isDraft: true }),
        unsynced,
      ]),
    );
    expect(lines.map((line) => line.link.number)).toEqual([3, 2, 1, 5, 4]);
  });

  it("keeps mixed stacks active and intact ahead of newer completed stacks", () => {
    const lines = pullRequestListLines(
      resolveThreadPullRequestChains([
        link(9, "done-base", "main", "2026-01-03T10:00:00Z", null, { state: "merged" }),
        link(10, "done-top", "done-base", "2026-01-03T11:00:00Z", null, { state: "closed" }),
        link(1, "active-base", "main", "2026-01-01T10:00:00Z", null, { state: "merged" }),
        link(2, "active-top", "active-base", "2026-01-01T11:00:00Z", null, { isDraft: true }),
        link(3, "solo", "main", "2026-01-02T10:00:00Z"),
      ]),
    );
    expect(lines.map((line) => [line.link.number, line.depth])).toEqual([
      [3, 0],
      [1, 0],
      [2, 1],
      [9, 0],
      [10, 1],
    ]);
  });

  it("orders newest first and keeps a stack together under its base layer", () => {
    const lines = pullRequestListLines(
      resolveThreadPullRequestChains([
        link(1, "a", "main", "2026-01-01T10:00:00Z"),
        link(2, "b", "a", "2026-01-01T12:00:00Z"),
        link(9, "solo", "main", "2026-01-01T11:00:00Z"),
        link(5, "old", "main", "2026-01-01T09:00:00Z"),
      ]),
    );
    expect(lines.map((line) => [line.link.number, line.depth, line.stack?.size ?? null])).toEqual([
      // The stack's newest layer is #2 at 12:00, so the whole stack outranks #9 at 11:00.
      [1, 0, 2],
      [2, 1, null],
      [9, 0, null],
      [5, 0, null],
    ]);
  });

  it("marks native stacks on their base layer", () => {
    const stack = {
      kind: "native" as const,
      id: "1",
      number: 1,
      url: "https://github.com/acme/web/stacks/1",
      base: "main",
      layers: [
        { number: 3, headBranch: "x", state: "open" as const },
        { number: 4, headBranch: "y", state: "open" as const },
      ],
    };
    const lines = pullRequestListLines(
      resolveThreadPullRequestChains([
        link(4, "y", "x", "2026-01-01T10:00:00Z", stack),
        link(3, "x", "main", "2026-01-01T10:00:00Z", stack),
      ]),
    );
    expect(lines.map((line) => [line.link.number, line.depth, line.stack?.kind ?? null])).toEqual([
      [3, 0, "native"],
      [4, 1, null],
    ]);
  });
});
