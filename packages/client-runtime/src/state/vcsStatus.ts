import type { EnvironmentId, VcsStatusResult } from "@t3tools/contracts";

export interface VcsStatusTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}

/**
 * Whether creating a worktree can only fail because the repository has no
 * commits to branch from. Shared by web and mobile so both surfaces gate on
 * the predicate the server actually enforces: whether the base ref resolves,
 * not whether the local HEAD is unborn. Starting from origin branches off a
 * remote commit, which works while the local HEAD has none — and if the
 * remote turns out to be empty too, the server guard is what says so. Old
 * servers omit `hasHeadCommit`; they read as committed and gate nothing.
 */
export function worktreeNeedsFirstCommit(
  status: Pick<VcsStatusResult, "isRepo" | "hasHeadCommit" | "hasPrimaryRemote"> | null | undefined,
  startFromOrigin: boolean,
): boolean {
  if (status?.isRepo !== true || status.hasHeadCommit !== false) {
    return false;
  }
  return !(startFromOrigin && status.hasPrimaryRemote);
}
