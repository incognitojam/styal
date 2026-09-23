import { useAtomValue } from "@effect/atom-react";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { deriveTurnUsage, EMPTY_TURN_USAGE, type TurnUsageByTurn } from "@t3tools/shared/turnUsage";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";

import { mobilePreferencesAtom } from "./preferences";

/**
 * Turn usage that keeps its identity until a usage activity arrives, so feed
 * rows keyed on it do not refresh on every streamed activity. Empty while the
 * device preference hides it.
 */
export function useTurnUsage(
  activities: ReadonlyArray<OrchestrationThreadActivity> | undefined,
): TurnUsageByTurn {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const enabled =
    !AsyncResult.isSuccess(preferences) || preferences.value.turnUsageEnabled !== false;
  const [previous, setPrevious] = useState(EMPTY_TURN_USAGE);
  const usage = useMemo(
    () => (enabled && activities ? deriveTurnUsage(activities, previous) : EMPTY_TURN_USAGE),
    [activities, enabled, previous],
  );
  if (usage !== previous) setPrevious(usage);
  return usage;
}
