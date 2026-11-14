import {
  FORK_CLIENT_USAGE_VERSION,
  type ClientOs,
  type ClientSurface,
  type ReportForkClientUsageInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as AnalyticsService from "./AnalyticsService.ts";

/** Buffer device stream summaries using this socket's attribution and opt-out. */
export const reporter = Effect.fnUntraced(function* (client: {
  readonly surface?: ClientSurface | undefined;
  readonly clientOs?: ClientOs | undefined;
  readonly clientAppVersion?: string | undefined;
}) {
  const analytics = yield* AnalyticsService.AnalyticsService;
  return (input: ReportForkClientUsageInput) => {
    if (input.feature !== "device-stream-health" || !client.surface) return Effect.void;
    const { feature: _feature, action: _action, ...summary } = input;
    return analytics
      .record("device.stream.summary", {
        ...summary,
        forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION,
        surface: client.surface,
        ...(client.clientOs ? { clientOs: client.clientOs } : {}),
        ...(client.clientAppVersion ? { clientAppVersion: client.clientAppVersion } : {}),
      })
      .pipe(Effect.ignoreCause);
  };
});
