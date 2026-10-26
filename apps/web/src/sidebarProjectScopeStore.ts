/**
 * Lives outside sidebar component state because the responsive sidebar remounts when it swaps to
 * the mobile sheet, and the command palette mounts above the sidebar.
 */

import { useClientSettings } from "./hooks/useSettings";
import { selectProjectGroupingSettings } from "./logicalProject";
import {
  resolveSidebarProjectScopeKey,
  type SidebarProjectSnapshot,
} from "./sidebarProjectGrouping";
import { useUiStateStore } from "./uiStateStore";

/**
 * The project group the filter points at, or null when the filter is off or
 * names a group that no longer exists (an unreachable scope must not silently
 * capture new threads). Resolves the stored key the way the sidebar does,
 * since the sidebar no longer writes the resolved key back.
 */
export function useScopedProjectGroup<T extends SidebarProjectSnapshot>(
  groups: readonly T[],
): T | null {
  const storedKey = useUiStateStore((state) => state.sidebarProjectScopeKey);
  const settings = useClientSettings(selectProjectGroupingSettings);
  const projectScopeKey = resolveSidebarProjectScopeKey({ groups, key: storedKey, settings });
  return projectScopeKey === null
    ? null
    : (groups.find((group) => group.projectKey === projectScopeKey) ?? null);
}
