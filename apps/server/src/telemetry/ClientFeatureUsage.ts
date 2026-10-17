import {
  FORK_CLIENT_USAGE_VERSION,
  LOCAL_DEVICE_HOST_ID,
  type ForkClientUsageInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as DeviceService from "../device/DeviceService.ts";
import * as ProjectNotices from "../project/ProjectNotices.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as FeatureUsage from "./FeatureUsage.ts";

/** Buffer allowlisted client observations using this socket's attribution and opt-out. */
export const reporter = Effect.fnUntraced(function* (client: FeatureUsage.ClientDimensions) {
  const analytics = yield* AnalyticsService.AnalyticsService;
  return (input: ForkClientUsageInput) => {
    if (client.surface !== "web" && client.surface !== "desktop") return Effect.void;
    if (input.feature === "web-build-update-notice" && client.surface !== "web") {
      return Effect.void;
    }
    const exposed = input.feature === "web-build-update-notice" && input.action === "notice_shown";
    return analytics
      .record(exposed ? "feature.exposed" : "feature.used", {
        ...input,
        source: exposed ? "system" : "user",
        forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION,
        surface: client.surface,
        ...(client.clientOs ? { clientOs: client.clientOs } : {}),
        ...(client.clientAppVersion ? { clientAppVersion: client.clientAppVersion } : {}),
      })
      .pipe(Effect.ignoreCause);
  };
});

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

/** Observe notices resolved from Project Settings; agents' tool calls are observed separately. */
export const notices = Effect.fnUntraced(function* (client: FeatureUsage.ClientDimensions) {
  const service = yield* ProjectNotices.ProjectNotices;
  const analytics = yield* AnalyticsService.AnalyticsService;
  if (!client.surface) return service;
  return ProjectNotices.ProjectNotices.of({
    ...service,
    resolve: (noticeId) =>
      FeatureUsage.observe(
        { feature: "notices", action: "resolve", source: "user" },
        service.resolve(noticeId),
        client,
      ).pipe(Effect.provideService(AnalyticsService.AnalyticsService, analytics)),
  });
});
