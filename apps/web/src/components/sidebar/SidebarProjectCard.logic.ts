import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveThreadListStatus } from "@t3tools/client-runtime/state/thread-list-status";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import { addThreadTokenUsage } from "@t3tools/shared/turnUsage";

export interface ProjectCardTotals {
  readonly open: number;
  readonly settled: number;
  readonly working: number;
  readonly needYou: number;
  readonly openPullRequests: number;
  readonly usage: EnvironmentThreadShell["tokenUsage"];
}

/**
 * Totals for a project's hover card. The chat is left out of the thread counts, which describe
 * the threads it coordinates, but its pull requests and usage count.
 */
export function projectCardTotals(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  chat: Pick<EnvironmentThreadShell, "environmentId" | "id"> | null,
  delegatedUnderParent: ReadonlySet<string>,
): ProjectCardTotals {
  let open = 0;
  let settled = 0;
  let working = 0;
  let needYou = 0;
  let usage: EnvironmentThreadShell["tokenUsage"];
  const pullRequestUrls = new Set<string>();
  for (const thread of threads) {
    if (thread.archivedAt != null || thread.deletedAt != null) continue;
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    if (isShownUnderParent(ref, thread.lineage, delegatedUnderParent)) continue;
    if (thread.tokenUsage !== undefined) {
      usage =
        usage === undefined ? thread.tokenUsage : addThreadTokenUsage(usage, thread.tokenUsage);
    }
    for (const pr of thread.pullRequests ?? []) {
      if (pr.snapshot?.state === "open") pullRequestUrls.add(pr.url);
    }
    if (chat !== null && thread.environmentId === chat.environmentId && thread.id === chat.id) {
      continue;
    }
    if (thread.settledOverride === "settled") {
      settled += 1;
      continue;
    }
    open += 1;
    switch (resolveThreadListStatus(thread)) {
      case "approval":
      case "input":
        needYou += 1;
        break;
      case "preparing":
      case "working":
        working += 1;
        break;
    }
  }
  return { open, settled, working, needYou, openPullRequests: pullRequestUrls.size, usage };
}
