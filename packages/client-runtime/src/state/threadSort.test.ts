import { describe, expect, it } from "vite-plus/test";

import {
  planPinnedMove,
  sortPinnedThreadsByOrderKey,
  sortThreads,
  sortThreadsByWorkspaceCluster,
  threadWorkspaceKey,
  type ThreadSortInput,
  type WorkspaceClusterThread,
} from "./threadSort.ts";

type TestThread = { readonly id: string } & ThreadSortInput;

function makeThread(overrides: Partial<TestThread> = {}): TestThread {
  return {
    id: "thread-1",
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    messages: [],
    latestUserMessageAt: null,
    ...overrides,
  };
}

describe("sortThreads", () => {
  it("falls back to updatedAt and createdAt when latestUserMessageAt is invalid and there are no messages", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: "thread-1",
          latestUserMessageAt: "not-a-date",
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
        makeThread({
          id: "thread-2",
          latestUserMessageAt: "still-not-a-date",
          createdAt: "invalid-created-at",
          updatedAt: "invalid-updated-at",
        }),
        makeThread({
          id: "thread-3",
          latestUserMessageAt: "invalid-latest-user-message-at",
          createdAt: "2026-03-09T10:06:00.000Z",
          updatedAt: "invalid-updated-at",
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual(["thread-3", "thread-1", "thread-2"]);
  });

  it("falls back to the latest valid user message when latestUserMessageAt is invalid", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: "thread-1",
          latestUserMessageAt: "invalid-latest-user-message-at",
          updatedAt: "2026-03-09T10:00:00.000Z",
          messages: [
            { role: "user", createdAt: "2026-03-09T10:05:00.000Z" },
            { role: "assistant", createdAt: "2026-03-09T10:30:00.000Z" },
            { role: "user", createdAt: "2026-03-09T10:20:00.000Z" },
          ],
        }),
        makeThread({
          id: "thread-2",
          createdAt: "2026-03-09T10:15:00.000Z",
          updatedAt: "2026-03-09T10:15:00.000Z",
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual(["thread-1", "thread-2"]);
  });
});

describe("planPinnedMove", () => {
  it("moves a thread up with a single key write", () => {
    const assignments = planPinnedMove({
      orderedIds: ["a", "b", "c"],
      keysById: new Map([
        ["a", "f"],
        ["b", "m"],
        ["c", "t"],
      ]),
      movedId: "c",
      direction: "up",
    });
    expect(assignments).toHaveLength(1);
    expect(assignments![0]!.id).toBe("c");
    expect(assignments![0]!.orderKey > "f" && assignments![0]!.orderKey < "m").toBe(true);
  });

  it("returns null when the move falls off the end of the list", () => {
    const input = {
      orderedIds: ["a", "b"],
      keysById: new Map([
        ["a", "f"],
        ["b", "m"],
      ]),
    };
    expect(planPinnedMove({ ...input, movedId: "a", direction: "up" })).toBeNull();
    expect(planPinnedMove({ ...input, movedId: "b", direction: "down" })).toBeNull();
  });

  it("materializes keys for the whole section when a neighbor is keyless", () => {
    const assignments = planPinnedMove({
      orderedIds: ["a", "b", "c"],
      keysById: new Map([
        ["a", null],
        ["b", "m"],
        ["c", null],
      ]),
      movedId: "b",
      direction: "up",
    });
    expect(assignments).not.toBeNull();
    const keys = assignments!.map((entry) => entry.orderKey);
    expect([...keys].sort()).toEqual(keys);
  });
});

describe("sortPinnedThreadsByOrderKey", () => {
  it("breaks equal keys by id THEN environment so merged lists are stable everywhere", () => {
    const sorted = sortPinnedThreadsByOrderKey([
      {
        id: "thread-1",
        createdAt: "2026-03-09T10:00:00.000Z",
        pinOrderKey: "m",
        environmentId: "env-b",
      },
      {
        id: "thread-1",
        createdAt: "2026-03-09T11:00:00.000Z",
        pinOrderKey: "m",
        environmentId: "env-a",
      },
    ]);
    expect(sorted.map((thread) => thread.environmentId)).toEqual(["env-a", "env-b"]);
  });
});

describe("sortThreadsByWorkspaceCluster", () => {
  const workspaceThread = (
    overrides: Partial<WorkspaceClusterThread> & { id: string; createdAt: string },
  ): WorkspaceClusterThread => ({
    environmentId: "env-1",
    projectId: "project-1",
    branch: null,
    worktreePath: null,
    ...overrides,
  });

  it("orders unclustered threads by creation time, newest first", () => {
    const sorted = sortThreadsByWorkspaceCluster([
      workspaceThread({ id: "oldest", createdAt: "2026-08-01T08:00:00.000Z" }),
      workspaceThread({ id: "newest", createdAt: "2026-08-01T12:00:00.000Z" }),
      workspaceThread({ id: "middle", createdAt: "2026-08-01T10:00:00.000Z" }),
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("breaks creation-time ties by id so the order is stable", () => {
    const sorted = sortThreadsByWorkspaceCluster([
      workspaceThread({ id: "b", createdAt: "2026-08-01T10:00:00.000Z" }),
      workspaceThread({ id: "a", createdAt: "2026-08-01T10:00:00.000Z" }),
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["a", "b"]);
  });

  it("keeps same-worktree threads adjacent, original first, at the newest member's slot", () => {
    const sorted = sortThreadsByWorkspaceCluster([
      workspaceThread({
        id: "feature",
        createdAt: "2026-08-01T08:00:00.000Z",
        worktreePath: "/wt/feature",
      }),
      workspaceThread({ id: "unrelated", createdAt: "2026-08-01T10:00:00.000Z" }),
      // Spawned review pulls the whole family above the unrelated thread.
      workspaceThread({
        id: "review",
        createdAt: "2026-08-01T12:00:00.000Z",
        worktreePath: "/wt/feature",
      }),
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["feature", "review", "unrelated"]);
  });

  it("surfaces an un-settled workspace family without changing its member order", () => {
    const sorted = sortThreadsByWorkspaceCluster([
      workspaceThread({
        id: "feature",
        createdAt: "2026-08-01T08:00:00.000Z",
        worktreePath: "/wt/feature",
      }),
      workspaceThread({ id: "unrelated", createdAt: "2026-08-01T12:00:00.000Z" }),
      workspaceThread({
        id: "review",
        createdAt: "2026-08-01T10:00:00.000Z",
        unsettledAt: "2026-08-01T13:00:00.000Z",
        worktreePath: "/wt/feature",
      }),
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["feature", "review", "unrelated"]);
  });

  it("clusters local-checkout threads only by an explicitly set branch", () => {
    const sorted = sortThreadsByWorkspaceCluster([
      workspaceThread({ id: "plain-old", createdAt: "2026-08-01T06:00:00.000Z" }),
      workspaceThread({
        id: "branch-old",
        createdAt: "2026-08-01T08:00:00.000Z",
        branch: "feature-x",
      }),
      // branch: null threads never cluster with each other.
      workspaceThread({ id: "plain-new", createdAt: "2026-08-01T10:00:00.000Z" }),
      workspaceThread({
        id: "branch-new",
        createdAt: "2026-08-01T12:00:00.000Z",
        branch: "feature-x",
      }),
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual([
      "branch-old",
      "branch-new",
      "plain-new",
      "plain-old",
    ]);
  });

  it("scopes branch families to their project and worktree families to their environment", () => {
    expect(
      threadWorkspaceKey(
        workspaceThread({ id: "a", createdAt: "2026-08-01T08:00:00.000Z", branch: "main" }),
      ),
    ).not.toEqual(
      threadWorkspaceKey(
        workspaceThread({
          id: "b",
          createdAt: "2026-08-01T08:00:00.000Z",
          branch: "main",
          projectId: "project-2",
        }),
      ),
    );
    expect(
      threadWorkspaceKey(
        workspaceThread({ id: "a", createdAt: "2026-08-01T08:00:00.000Z", worktreePath: "/wt/x" }),
      ),
    ).not.toEqual(
      threadWorkspaceKey(
        workspaceThread({
          id: "b",
          createdAt: "2026-08-01T08:00:00.000Z",
          worktreePath: "/wt/x",
          environmentId: "env-2",
        }),
      ),
    );
  });

  it("returns null keys for threads without a worktree or branch", () => {
    expect(
      threadWorkspaceKey(workspaceThread({ id: "a", createdAt: "2026-08-01T08:00:00.000Z" })),
    ).toBeNull();
  });
});
