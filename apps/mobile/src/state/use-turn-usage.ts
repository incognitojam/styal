import { useAtomValue } from "@effect/atom-react";
import type { OrchestrationV2ThreadProjection, ServerProvider } from "@t3tools/contracts";
import {
  deriveProjectionTurnUsage,
  EMPTY_TURN_SUMMARIES,
  EMPTY_TURN_USAGE,
  turnSummaryViews,
  type TurnRecord,
  type TurnSummaryView,
  type TurnUsageByTurn,
  type TurnUsageFigure,
} from "@t3tools/shared/turnUsage";
import { AsyncResult } from "effect/reactivity";
import { useMemo, useState } from "react";

import { mobilePreferencesAtom } from "./preferences";

/**
 * Turn usage that keeps its identity until a usage activity arrives, so feed
 * rows keyed on it do not refresh on every streamed activity. Empty while the
 * device preference hides it.
 */
export function useTurnUsage(
  projection: OrchestrationV2ThreadProjection | undefined,
): TurnUsageByTurn {
  const enabled = useTurnUsageEnabled();
  const [previous, setPrevious] = useState(EMPTY_TURN_USAGE);
  const usage = useMemo(
    () =>
      enabled && projection ? deriveProjectionTurnUsage(projection, previous) : EMPTY_TURN_USAGE,
    [projection, enabled, previous],
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

/** Which figure this device leads with; tokens until it chooses cost. */
export function useTurnUsageFigure(): TurnUsageFigure {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences) && preferences.value.turnUsageFigure === "cost"
    ? "cost"
    : "tokens";
}

/** Whether this device shows turn usage; on until it opts out. */
export function useTurnUsageEnabled(): boolean {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return !AsyncResult.isSuccess(preferences) || preferences.value.turnUsageEnabled !== false;
}
