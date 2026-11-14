import * as Effect from "effect/Effect";

import * as AnalyticsService from "./AnalyticsService.ts";

/** The automatic settlement rule that settled a thread. */
export type AutoSettleRule = "merged" | "closed" | "inactivity";

/**
 * Records one server auto-settle with its rule, and the configured threshold
 * for inactivity. Thread, project and pull request identifiers are never sent.
 */
export const recordAutoSettle = Effect.fn("ThreadSettleUsage.recordAutoSettle")(
  function* (rule: AutoSettleRule, afterDays: number | null) {
    const analytics = yield* AnalyticsService.AnalyticsService;
    yield* analytics.record("server.thread.settled", {
      reason: rule,
      ...(rule === "inactivity" && afterDays !== null ? { afterDays } : {}),
    });
  },
  (effect) => effect.pipe(Effect.ignoreCause),
);
