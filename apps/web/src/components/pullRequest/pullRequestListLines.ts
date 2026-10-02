import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { isOpen, type ThreadPullRequestChain } from "@t3tools/shared/threadPullRequests";

/** One line of a thread's pull-request list: a link plus how deep it sits in its stack. */
export interface PullRequestListLine {
  readonly link: ThreadPullRequestLink;
  /** 0 for a pull request on the base branch; each layer above steps in by one. */
  readonly depth: number;
  /** Which chain the line belongs to, so callers can tell one stack's lines from another's. */
  readonly chainKey: string;
  /** Set on the first displayed layer of a multi-layer stack, including omitted preview layers. */
  readonly stack: { readonly kind: ThreadPullRequestChain["kind"]; readonly size: number } | null;
}

function activityAt(link: ThreadPullRequestLink): number {
  const ms = Date.parse(link.snapshot?.updatedAt ?? link.linkedAt);
  return Number.isNaN(ms) ? 0 : ms;
}

function chainKeyOf(chain: ThreadPullRequestChain): string {
  const bottom = chain.layers[0]!;
  return `${bottom.host}/${bottom.repository}#${bottom.number}`;
}

/**
 * Flattens chains into indented lines, active work first and newest first within each group.
 * A stack is active if any layer is open or unsynced, sorts by its most recent layer, and
 * reads bottom to top so dependency order stays intact. Previews start active stacks at their
 * lowest open layer, preserving depth and moving the stack label to the first displayed row.
 */
export function pullRequestListLines(
  chains: ReadonlyArray<ThreadPullRequestChain>,
  { preview = false }: { preview?: boolean } = {},
): ReadonlyArray<PullRequestListLine> {
  const ordered = chains
    .map((chain) => ({
      chain,
      active: chain.layers.some(isOpen),
      updatedAt: Math.max(...chain.layers.map(activityAt)),
    }))
    .sort(
      (left, right) =>
        Number(right.active) - Number(left.active) || right.updatedAt - left.updatedAt,
    );
  return ordered.flatMap(({ chain }) => {
    const chainKey = chainKeyOf(chain);
    const start = preview ? Math.max(0, chain.layers.findIndex(isOpen)) : 0;
    return chain.layers.slice(start).map((link, index) => ({
      link,
      depth: start + index,
      chainKey,
      stack:
        index === 0 && chain.layers.length > 1
          ? { kind: chain.kind, size: chain.layers.length }
          : null,
    }));
  });
}
