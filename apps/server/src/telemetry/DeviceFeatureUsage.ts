import { LOCAL_DEVICE_HOST_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Toolkit } from "effect/ai";

import type { DeviceStandardToolkit } from "../mcp/toolkits/device/tools.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as FeatureUsage from "./FeatureUsage.ts";

type Handlers = Toolkit.HandlersFrom<Toolkit.Tools<typeof DeviceStandardToolkit>>;

/** Observe the entire public operation, including selection, permission and screenshot encoding failures. */
export const observeHandlers = Effect.fnUntraced(function* (handlers: Handlers) {
  const analytics = yield* AnalyticsService.AnalyticsService;
  const observe = <A, E, R>(
    action: "list" | "open" | "close" | "snapshot",
    effect: Effect.Effect<A, E, R>,
  ) =>
    FeatureUsage.observe({ feature: "devices", action, source: "agent" }, effect).pipe(
      Effect.provideService(AnalyticsService.AnalyticsService, analytics),
    );
  return {
    device_list: (input, context) => observe("list", handlers.device_list(input, context)),
    device_open: (input, context) =>
      FeatureUsage.observe(
        {
          feature: "devices",
          action: "open",
          source: "agent",
          devicePlatform: input.platform,
          deviceLocation:
            input.hostId === undefined || input.hostId === LOCAL_DEVICE_HOST_ID
              ? "local"
              : "remote",
        },
        handlers.device_open(input, context),
      ).pipe(Effect.provideService(AnalyticsService.AnalyticsService, analytics)),
    device_close: (input, context) => observe("close", handlers.device_close(input, context)),
  } satisfies Handlers;
});

export const snapshotObserver = Effect.gen(function* () {
  const analytics = yield* AnalyticsService.AnalyticsService;
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    FeatureUsage.observe({ feature: "devices", action: "snapshot", source: "agent" }, effect).pipe(
      Effect.provideService(AnalyticsService.AnalyticsService, analytics),
    );
});
