import { describe, expect, it } from "@effect/vitest";

import { worktreeNeedsFirstCommit } from "./vcs.ts";

describe("worktreeNeedsFirstCommit", () => {
  it.each([false, true])(
    "gates an unborn repository with hasPrimaryRemote=%s",
    (hasPrimaryRemote) => {
      const status = { isRepo: true, hasHeadCommit: false, hasPrimaryRemote };
      expect(worktreeNeedsFirstCommit(status)).toBe(true);
    },
  );

  it("allows worktrees after the first commit", () => {
    expect(worktreeNeedsFirstCommit({ isRepo: true, hasHeadCommit: true })).toBe(false);
  });

  it("allows old servers that omit the field", () => {
    expect(worktreeNeedsFirstCommit({ isRepo: true })).toBe(false);
  });

  it("gates nothing outside a repository or before status arrives", () => {
    expect(worktreeNeedsFirstCommit({ isRepo: false, hasHeadCommit: false })).toBe(false);
    expect(worktreeNeedsFirstCommit(null)).toBe(false);
    expect(worktreeNeedsFirstCommit(undefined)).toBe(false);
  });
});
