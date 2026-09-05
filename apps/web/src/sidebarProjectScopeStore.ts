/**
 * The sidebar's project filter, read outside the sidebar tree.
 *
 * The filter is persisted in the UI state store. Two consumers sit where
 * sidebar component state could not reach them: the responsive sidebar
 * remounts when it swaps its desktop container for the mobile sheet, and the
 * command palette mounts at the root, above the sidebar. Every new-thread
 * entry point reads this so a chosen project decides where the next thread
 * lands.
 */
import { useMemo } from "react";

import { useUiStateStore } from "./uiStateStore";

/**
 * The project group the filter points at, or null when the filter is off or
 * names a group that no longer exists (an unreachable scope must not silently
 * capture new threads).
 */
export function useScopedProjectGroup<T extends { readonly projectKey: string }>(
  groups: readonly T[],
): T | null {
  const projectScopeKey = useUiStateStore((state) => state.sidebarProjectScopeKey);
  return useMemo(
    () =>
      projectScopeKey === null
        ? null
        : (groups.find((group) => group.projectKey === projectScopeKey) ?? null),
    [groups, projectScopeKey],
  );
}
