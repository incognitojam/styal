import { describe, expect, it } from "@effect/vitest";

import { worktreeNeedsFirstCommit } from "./vcsStatus.ts";

describe("worktreeNeedsFirstCommit", () => {
  const unborn = { isRepo: true, hasHeadCommit: false, hasPrimaryRemote: false };

  it("gates a repository with no commits", () => {
    expect(worktreeNeedsFirstCommit(unborn, false)).toBe(true);
  });

  it("defers to the server when starting from a populated origin", () => {
    expect(worktreeNeedsFirstCommit({ ...unborn, hasPrimaryRemote: true }, true)).toBe(false);
  });

  it("still gates start-from-origin without a primary remote", () => {
    expect(worktreeNeedsFirstCommit(unborn, true)).toBe(true);
  });

  it("gates nothing for old servers that omit the field", () => {
    expect(
      worktreeNeedsFirstCommit({ isRepo: true, hasPrimaryRemote: false } as never, false),
    ).toBe(false);
  });

  it("gates nothing outside a repository or before status arrives", () => {
    expect(
      worktreeNeedsFirstCommit(
        { isRepo: false, hasHeadCommit: false, hasPrimaryRemote: false },
        false,
      ),
    ).toBe(false);
    expect(worktreeNeedsFirstCommit(null, false)).toBe(false);
    expect(worktreeNeedsFirstCommit(undefined, false)).toBe(false);
  });
});
