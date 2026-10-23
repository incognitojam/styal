import type { ForkClientUsageInput } from "@t3tools/contracts";

import { reportSidebarUsage } from "./sidebarProjectFilterUsage";

type GroupUsage = Extract<ForkClientUsageInput, { feature: "sidebar-project-groups" }>;

/** Count a project reorder, pin, unpin or archive made from a grouped sidebar header. */
export function reportSidebarProjectGroupUsage(
  action: GroupUsage["action"],
  entryPoint: GroupUsage["entryPoint"],
) {
  return reportSidebarUsage({ feature: "sidebar-project-groups", action, entryPoint });
}
