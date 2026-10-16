import type { WebBuildUpdateUsageInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AnalyticsService from "./AnalyticsService.ts";
import * as FeatureUsage from "./FeatureUsage.ts";

export class WebBuildUpdateUsage extends Context.Service<
  WebBuildUpdateUsage,
  {
    readonly report: (
      input: WebBuildUpdateUsageInput,
      client: FeatureUsage.ClientDimensions,
    ) => Effect.Effect<void>;
  }
>()("@styal/cli/telemetry/WebBuildUpdateUsage") {}

const make = Effect.gen(function* () {
  const analytics = yield* AnalyticsService.AnalyticsService;
  return WebBuildUpdateUsage.of({
    report: (input, client) =>
      client.surface !== "web"
        ? Effect.void
        : FeatureUsage.observe(
            {
              feature: "web-build-update-notice",
              action: input.action,
              source: input.action === "notice_shown" ? "system" : "user",
            },
            Effect.void,
            client,
          ).pipe(Effect.provideService(AnalyticsService.AnalyticsService, analytics)),
  });
});

export const layer = Layer.effect(WebBuildUpdateUsage, make);
