import type { ForkClientUsageInput } from "@t3tools/contracts";

import { useUiStateStore } from "./uiStateStore";

type FilterEntryPoint = Extract<
  ForkClientUsageInput,
  { feature: "sidebar-project-filter"; entryPoint: unknown }
>["entryPoint"];

/**
 * The filter is a device preference rather than a property of one project, so
 * reports go through the primary environment like the page-level update notice.
 * The reporting modules load on first use so thread actions stay free of the
 * connection layer.
 */
export async function reportSidebarUsage(
  input: Extract<
    ForkClientUsageInput,
    { feature: "sidebar-project-filter" | "sidebar-project-groups" | "next-unread-thread" }
  >,
) {
  try {
    const [{ reportForkClientUsage }, { appAtomRegistry }, { primaryEnvironmentIdAtom }] =
      await Promise.all([
        import("./forkClientUsage"),
        import("./rpc/atomRegistry"),
        import("./state/primaryEnvironment"),
      ]);
    await reportForkClientUsage(appAtomRegistry.get(primaryEnvironmentIdAtom), input);
  } catch {
    // Reporting must never affect the sidebar or thread creation.
  }
}

/** Apply a filter choice the user made and count it. Automatic clears go straight to the store. */
export function setSidebarProjectFilterFromUser(
  projectKeys: readonly string[],
  entryPoint: FilterEntryPoint,
) {
  const store = useUiStateStore.getState();
  store.setSidebarProjectScopeKeys(projectKeys);
  if (useUiStateStore.getState().sidebarProjectScopeKeys === store.sidebarProjectScopeKeys) return;
  return reportSidebarUsage({
    feature: "sidebar-project-filter",
    action: projectKeys.length === 0 ? "filter_cleared" : "filter_set",
    entryPoint,
  });
}

/** Count a new-thread action taken while the filter is on. */
export function reportNewThreadWhileFiltered() {
  if (useUiStateStore.getState().sidebarProjectScopeKeys.length === 0) return;
  return reportSidebarUsage({ feature: "sidebar-project-filter", action: "thread_started" });
}
