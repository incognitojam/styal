import { LOCAL_DEVICE_HOST_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as DeviceService from "../device/DeviceService.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as FeatureUsage from "./FeatureUsage.ts";

/** Observe Device panel operations without counting environment relays as user choices. */
export const devices = Effect.fnUntraced(function* (client: FeatureUsage.ClientDimensions) {
  const service = yield* DeviceService.DeviceService;
  const analytics = yield* AnalyticsService.AnalyticsService;
  // Environment-to-environment device RPCs and older clients have no surface.
  // Their origin is unknown; forwarding a device operation must not count it twice.
  if (!client.surface) return service;
  const observe = <A, E, R>(
    action: Parameters<typeof FeatureUsage.observe>[0] & { feature: "devices" },
    effect: Effect.Effect<A, E, R>,
  ) =>
    FeatureUsage.observe(action, effect, client).pipe(
      Effect.provideService(AnalyticsService.AnalyticsService, analytics),
    );
  const location = (hostId: string | undefined) =>
    hostId === undefined || hostId === LOCAL_DEVICE_HOST_ID
      ? ("local" as const)
      : ("remote" as const);
  return DeviceService.DeviceService.of({
    ...service,
    open: (input) =>
      observe(
        {
          feature: "devices",
          action: "open",
          source: "user",
          devicePlatform: input.platform,
          deviceLocation: location(input.hostId),
        },
        service.open(input),
      ),
    close: (input) =>
      observe(
        {
          feature: "devices",
          action: "close",
          source: "user",
          ...(input.hostId === undefined ? {} : { deviceLocation: location(input.hostId) }),
        },
        service.close(input),
      ),
    shutdown: (input) =>
      observe(
        {
          feature: "devices",
          action: "shutdown",
          source: "user",
          devicePlatform: input.platform,
          deviceLocation: location(input.hostId),
        },
        service.shutdown(input),
      ),
    action: (input) =>
      observe(
        {
          feature: "devices",
          action: input.type,
          source: "user",
          deviceLocation: location(input.hostId),
        },
        service.action(input),
      ),
  });
});
