import type { ForkClientUsageInput } from "@t3tools/contracts";

import { reportForkClientUsage } from "./forkClientUsage";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "./state/primaryEnvironment";
import { useUiStateStore } from "./uiStateStore";

type FilterEntryPoint = Extract<
  ForkClientUsageInput,
  { feature: "sidebar-project-filter"; entryPoint: unknown }
>["entryPoint"];

/**
 * The filter is a device preference rather than a property of one project, so
 * reports go through the primary environment like the page-level update notice.
 */
function report(input: Extract<ForkClientUsageInput, { feature: "sidebar-project-filter" }>) {
  try {
    void reportForkClientUsage(appAtomRegistry.get(primaryEnvironmentIdAtom), input);
  } catch {
    // Reporting must never affect the filter or thread creation.
  }
}

/** Apply a filter choice the user made and count it. Automatic clears go straight to the store. */
export function setSidebarProjectFilterFromUser(
  projectKey: string | null,
  entryPoint: FilterEntryPoint,
) {
  const store = useUiStateStore.getState();
  if (store.sidebarProjectScopeKey === projectKey) return;
  store.setSidebarProjectScopeKey(projectKey);
  report({
    feature: "sidebar-project-filter",
    action: projectKey === null ? "filter_cleared" : "filter_set",
    entryPoint,
  });
}

/** Count a new-thread action taken while the filter is on. */
export function reportNewThreadWhileFiltered() {
  if (useUiStateStore.getState().sidebarProjectScopeKey === null) return;
  report({ feature: "sidebar-project-filter", action: "thread_started" });
}
