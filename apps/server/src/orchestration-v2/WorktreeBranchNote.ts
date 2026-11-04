import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";

import type { GitBranchRename } from "../vcs/GitVcsDriver.ts";

/**
 * A new worktree starts on a temporary branch that is renamed in the background, usually after
 * the agent's session has started. Claude Code's git status snapshot and the worktree folder keep
 * the temporary name, so the agent is told about the rename rather than left to reuse a stale name.
 */
export function worktreeBranchNote(input: {
  /** The branch checked out when this turn starts, or null for a detached HEAD. */
  readonly currentBranch: string | null;
  /** When the thread's previous provider turn started, or null on its first turn. */
  readonly previousTurnStartedAtMs: number | null;
  readonly renames: ReadonlyArray<GitBranchRename>;
}): string {
  const { currentBranch, previousTurnStartedAtMs } = input;
  if (previousTurnStartedAtMs === null) {
    return currentBranch !== null && isTemporaryWorktreeBranch(currentBranch)
      ? `Note: this worktree's branch, \`${currentBranch}\`, has a temporary name and may be renamed while you work. The worktree folder keeps the temporary name. Run \`git branch --show-current\` before you use the branch name in a command.`
      : "";
  }
  const rename = input.renames.find(
    (candidate) =>
      candidate.renamedAtMs >= previousTurnStartedAtMs && isTemporaryWorktreeBranch(candidate.from),
  );
  if (rename === undefined) return "";
  const current =
    currentBranch === rename.to
      ? ""
      : currentBranch === null
        ? " HEAD is now detached."
        : ` The current branch is \`${currentBranch}\`.`;
  return `Note: this worktree's branch \`${rename.from}\` was renamed to \`${rename.to}\` after your previous turn started.${current} The worktree folder keeps the old name.`;
}
