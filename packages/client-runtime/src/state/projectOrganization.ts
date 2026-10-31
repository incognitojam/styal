import type { OrchestrationProjectShell } from "@t3tools/contracts";

import { pinOrderKeyBetween, planPinnedReorder } from "./threadSort.ts";

type ProjectPinFields = Pick<OrchestrationProjectShell, "pinnedAt" | "pinOrderKey">;

/**
 * Records can disagree (an agent changed one, or a machine added the project later): the project
 * is pinned when any record is, at its earliest pin time and first slot.
 */
export function resolveProjectGroupPinOrder(members: ReadonlyArray<ProjectPinFields>): {
  readonly pinnedAt: string | null;
  readonly pinOrderKey: string | null;
} {
  let pinnedAt: string | null = null;
  let pinOrderKey: string | null = null;
  for (const member of members) {
    if (member.pinnedAt == null) continue;
    if (pinnedAt === null || member.pinnedAt < pinnedAt) pinnedAt = member.pinnedAt;
    if (member.pinOrderKey != null && (pinOrderKey === null || member.pinOrderKey < pinOrderKey))
      pinOrderKey = member.pinOrderKey;
  }
  return { pinnedAt, pinOrderKey };
}

interface PinnableProject {
  readonly pinnedAt?: string | null | undefined;
  readonly pinOrderKey?: string | null | undefined;
}

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Pinned projects first, in slot order and then keyless pins (set by an
 * agent) in the order they were pinned. The rest keep the order given.
 */
export function sortPinnedProjectsFirst<T extends PinnableProject>(projects: readonly T[]): T[] {
  const pinned = projects.filter((project) => project.pinnedAt != null);
  if (pinned.length === 0) return [...projects];
  pinned.sort((left, right) => {
    const leftKey = left.pinOrderKey ?? null;
    const rightKey = right.pinOrderKey ?? null;
    if (leftKey !== null && rightKey !== null) return compareText(leftKey, rightKey);
    if (leftKey !== null || rightKey !== null) return leftKey !== null ? -1 : 1;
    return compareText(left.pinnedAt!, right.pinnedAt!);
  });
  return [...pinned, ...projects.filter((project) => project.pinnedAt == null)];
}

/** Slot for a newly pinned project, after every pinned project that has one. */
export function nextProjectPinOrderKey(projects: ReadonlyArray<PinnableProject>): string | null {
  let lastKey: string | null = null;
  for (const project of projects) {
    if (project.pinnedAt == null || project.pinOrderKey == null) continue;
    if (lastKey === null || project.pinOrderKey > lastKey) lastKey = project.pinOrderKey;
  }
  return pinOrderKeyBetween(lastKey, null);
}

/**
 * Order-key writes that move one pinned project. Usually one write; a block
 * with keyless pins (pinned by an agent) is rewritten once.
 */
export function planProjectPinReorder(input: {
  /** Pinned project keys in the new order. */
  readonly orderedKeys: readonly string[];
  readonly pinOrderKeyByKey: ReadonlyMap<string, string | null>;
  readonly movedKey: string;
}): ReadonlyArray<{ readonly key: string; readonly pinOrderKey: string }> {
  return planPinnedReorder({
    orderedIds: input.orderedKeys,
    keysById: input.pinOrderKeyByKey,
    movedId: input.movedKey,
  }).map(({ id, orderKey }) => ({ key: id, pinOrderKey: orderKey }));
}
