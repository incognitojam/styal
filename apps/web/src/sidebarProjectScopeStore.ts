/**
 * Lives outside sidebar component state because the responsive sidebar remounts when it swaps to
 * the mobile sheet, and the command palette mounts above the sidebar.
 */

import { getClientSettings, useClientSettings } from "./hooks/useSettings";
import {
  selectProjectGroupingSettings,
  type ProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  resolveSidebarProjectScopeKeys,
  type SidebarProjectSnapshot,
} from "./sidebarProjectGrouping";
import { useUiStateStore } from "./uiStateStore";

/**
 * The project groups the filter points at, in list order: empty when the filter is
 * off or names only groups that no longer exist (an unreachable scope must not
 * silently capture new threads). Resolves the stored keys the way the sidebar does,
 * since the sidebar no longer writes the resolved keys back.
 */
export function useScopedProjectGroups<T extends SidebarProjectSnapshot>(
  groups: readonly T[],
): readonly T[] {
  const storedKeys = useUiStateStore((state) => state.sidebarProjectScopeKeys);
  const settings = useClientSettings(selectProjectGroupingSettings);
  return resolveScopedProjectGroups(groups, storedKeys, settings);
}

/** {@link useScopedProjectGroups} read at call time, for handlers outside React. */
export function readScopedProjectGroups<T extends SidebarProjectSnapshot>(
  groups: readonly T[],
): readonly T[] {
  return resolveScopedProjectGroups(
    groups,
    useUiStateStore.getState().sidebarProjectScopeKeys,
    selectProjectGroupingSettings(getClientSettings()),
  );
}

function resolveScopedProjectGroups<T extends SidebarProjectSnapshot>(
  groups: readonly T[],
  storedKeys: readonly string[],
  settings: ProjectGroupingSettings,
): readonly T[] {
  const projectScopeKeys = resolveSidebarProjectScopeKeys({ groups, keys: storedKeys, settings });
  return groups.filter((group) => projectScopeKeys.includes(group.projectKey));
}
