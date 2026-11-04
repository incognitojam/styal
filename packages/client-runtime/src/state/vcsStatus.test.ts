import { describe, expect, it } from "@effect/vitest";

import { worktreeNeedsFirstCommit } from "./vcs.ts";

const unborn = { isRepo: true, hasHeadCommit: false };

describe("worktreeNeedsFirstCommit", () => {
  it.each([false, true])(
    "gates an unborn repository with hasPrimaryRemote=%s and no default branch",
    (hasPrimaryRemote) => {
      const status = { ...unborn, hasPrimaryRemote };
      expect(worktreeNeedsFirstCommit(status, [])).toBe(true);
      expect(worktreeNeedsFirstCommit(status, [{ isDefault: false }])).toBe(true);
    },
  );

  it("gates an unborn repository until its refs load", () => {
    expect(worktreeNeedsFirstCommit(unborn, null)).toBe(true);
  });

  it("allows a worktree from the default branch in an unborn repository", () => {
    expect(worktreeNeedsFirstCommit(unborn, [{ isDefault: false }, { isDefault: true }])).toBe(
      false,
    );
  });

  it("allows worktrees after the first commit", () => {
    expect(worktreeNeedsFirstCommit({ isRepo: true, hasHeadCommit: true }, [])).toBe(false);
  });

  it("allows old servers that omit the field", () => {
    expect(worktreeNeedsFirstCommit({ isRepo: true }, [])).toBe(false);
  });

  it("gates nothing outside a repository or before status arrives", () => {
    expect(worktreeNeedsFirstCommit({ isRepo: false, hasHeadCommit: false }, [])).toBe(false);
    expect(worktreeNeedsFirstCommit(null, [])).toBe(false);
    expect(worktreeNeedsFirstCommit(undefined, [])).toBe(false);
  });
});
