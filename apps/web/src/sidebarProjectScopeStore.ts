/**
 * The sidebar's project filter, kept outside the sidebar tree.
 *
 * Two consumers sit where component state could not reach them: the responsive
 * sidebar remounts when it swaps its desktop container for the mobile sheet,
 * and the command palette mounts at the root, above the sidebar. Every
 * new-thread entry point reads this so a chosen project decides where the next
 * thread lands.
 */
import { useMemo } from "react";
import { create } from "zustand";

interface SidebarProjectScopeStore {
  /** The scoped logical project key, or null for "All projects". */
  projectScopeKey: string | null;
  setProjectScopeKey: (projectScopeKey: string | null) => void;
}

export const useSidebarProjectScopeStore = create<SidebarProjectScopeStore>((set) => ({
  projectScopeKey: null,
  setProjectScopeKey: (projectScopeKey) => set({ projectScopeKey }),
}));

/**
 * The project group the filter points at, or null when the filter is off or
 * names a group that no longer exists (an unreachable scope must not silently
 * capture new threads).
 */
export function useScopedProjectGroup<T extends { readonly projectKey: string }>(
  groups: readonly T[],
): T | null {
  const projectScopeKey = useSidebarProjectScopeStore((state) => state.projectScopeKey);
  return useMemo(
    () =>
      projectScopeKey === null
        ? null
        : (groups.find((group) => group.projectKey === projectScopeKey) ?? null),
    [groups, projectScopeKey],
  );
}
