/**
 * Lives outside sidebar component state because the responsive sidebar remounts when it swaps to
 * the mobile sheet, and the command palette mounts above the sidebar.
 */

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
  return projectScopeKey === null
    ? null
    : (groups.find((group) => group.projectKey === projectScopeKey) ?? null);
}
