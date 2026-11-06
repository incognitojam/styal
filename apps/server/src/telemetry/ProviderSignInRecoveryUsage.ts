import * as Effect from "effect/Effect";

import * as AnalyticsService from "./AnalyticsService.ts";

/** Records a thread starting to wait for a sign-in, or resuming after one. No identifiers are sent. */
export const record = Effect.fn("ProviderSignInRecoveryUsage.record")(
  function* (action: "wait" | "resume") {
    const analytics = yield* AnalyticsService.AnalyticsService;
    yield* analytics.record("feature.used", {
      feature: "provider-sign-in",
      source: "system",
      action,
    });
  },
  (effect) => effect.pipe(Effect.ignoreCause),
);
