import type { PreviewAutomationOperation } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import * as AnalyticsService from "./AnalyticsService.ts";

// Extend this union at the feature's entry point. Never pass tool arguments or
// results: usage properties are a fixed vocabulary, independent of user data.
type FeatureUsage = {
  readonly feature: "browser-tools";
  readonly action: PreviewAutomationOperation;
  readonly source: "agent";
};

/** Observe one public operation, preserving its result, failure and interruption. */
export const observe = <A, E, R>(usage: FeatureUsage, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const analytics = yield* AnalyticsService.AnalyticsService;
    const startedAt = yield* Clock.currentTimeMillis;
    return yield* effect.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const finishedAt = yield* Clock.currentTimeMillis;
          yield* analytics.record("feature.used", {
            feature: usage.feature,
            action: usage.action,
            source: usage.source,
            outcome: Exit.isSuccess(exit)
              ? "success"
              : Cause.hasInterruptsOnly(exit.cause)
                ? "cancelled"
                : "failure",
            durationMs: Math.max(0, finishedAt - startedAt),
          });
        }).pipe(Effect.ignoreCause),
      ),
    );
  });
