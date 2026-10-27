import { sortActiveThreadsByOrderKey } from "./threadSort.ts";

/** Stable-cluster `items` by group, keeping their relative order within a
    group. Groups missing from `groupOrder` lead, in order of their first
    item; the rest follow `groupOrder`. */
export function clusterByGroup<T>(
  items: readonly T[],
  groupOf: (item: T) => string,
  groupOrder: readonly string[] = [],
): T[] {
  const clusters = new Map<string, T[]>();
  for (const item of items) {
    const group = groupOf(item);
    const cluster = clusters.get(group);
    if (cluster) cluster.push(item);
    else clusters.set(group, [item]);
  }
  const ordered = new Set(groupOrder);
  return [
    ...[...clusters].flatMap(([group, cluster]) => (ordered.has(group) ? [] : cluster)),
    ...groupOrder.flatMap((group) => clusters.get(group) ?? []),
  ];
}

/** Group placement follows new/reopened threads or the saved project order,
 * after pinned projects in their pin order. Manual thread keys only affect
 * rows within a project, including during an optimistic drop before those
 * keys have arrived from the server. */
export function groupActiveThreadsByProject<
  T extends Parameters<typeof sortActiveThreadsByOrderKey>[0][number],
>(
  orderedThreads: readonly T[],
  groupOf: (thread: T) => string,
  savedGroupOrder: readonly string[] = [],
  pinnedGroupOrder: readonly string[] = [],
): T[] {
  const recentGroups = sortActiveThreadsByOrderKey(
    orderedThreads.map((thread) => ({
      id: thread.id,
      environmentId: thread.environmentId,
      createdAt: thread.createdAt,
      unsettledAt: thread.unsettledAt,
      group: groupOf(thread),
    })),
  );
  const pinnedGroups = new Set(pinnedGroupOrder);
  const savedGroups = new Set(savedGroupOrder);
  const groupOrder = [
    ...pinnedGroupOrder,
    ...new Set(
      recentGroups
        .map((thread) => thread.group)
        .filter((group) => !savedGroups.has(group) && !pinnedGroups.has(group)),
    ),
    ...savedGroupOrder.filter((group) => !pinnedGroups.has(group)),
  ];
  return clusterByGroup(orderedThreads, groupOf, groupOrder);
}

/** Cluster Working shelf threads by project in `projectOrder`, keeping the
 * newest-send order within each project. Sending to a thread moves it only
 * within its project, so headers never trade places as runs start. */
export function groupWorkingThreadsByProject<T>(
  sortedThreads: readonly T[],
  groupOf: (thread: T) => string,
  projectOrder: readonly string[],
): T[] {
  return clusterByGroup(sortedThreads, groupOf, [...new Set(projectOrder)]);
}
