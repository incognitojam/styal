import { useAtomValue } from "@effect/atom-react";
import type { OrchestrationThreadActivity, ServerProvider } from "@t3tools/contracts";
import {
  deriveTurnUsage,
  EMPTY_TURN_SUMMARIES,
  EMPTY_TURN_USAGE,
  turnSummaryViews,
  type TurnRecord,
  type TurnSummaryView,
  type TurnUsageByTurn,
} from "@t3tools/shared/turnUsage";
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

/** Each turn's model and usage, keeping identity while neither changes. */
export function useTurnSummaries(
  byTurnId: ReadonlyMap<string, TurnRecord>,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyMap<string, TurnSummaryView> {
  const [previous, setPrevious] = useState(EMPTY_TURN_SUMMARIES);
  const summaries = useMemo(
    () => turnSummaryViews(byTurnId, providers, previous),
    [byTurnId, providers, previous],
  );
  if (summaries !== previous) setPrevious(summaries);
  return summaries;
}
