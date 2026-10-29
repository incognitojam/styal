import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { supportsForkClientUsage } from "./forkClientUsage";
import { useServerConfigs } from "./state/entities";
import { primaryEnvironmentIdAtom } from "./state/primaryEnvironment";

/** The primary environment, or on hosted web the first paired one, if it accepts the report. */
export function useForkUsageEnvironmentId(): EnvironmentId | null {
  const primaryId = useAtomValue(primaryEnvironmentIdAtom);
  const configs = useServerConfigs();
  if (primaryId) return supportsForkClientUsage(configs.get(primaryId)) ? primaryId : null;
  for (const [environmentId, config] of configs) {
    if (supportsForkClientUsage(config)) return environmentId;
  }
  return null;
}
