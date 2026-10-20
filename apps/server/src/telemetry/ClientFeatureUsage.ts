import {
  FORK_CLIENT_USAGE_VERSION,
  LOCAL_DEVICE_HOST_ID,
  type ForkClientUsageInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as DeviceService from "../device/DeviceService.ts";
import * as HardwareService from "../hardware/HardwareService.ts";
import * as ProjectFileActionApprovals from "../project/ProjectFileActionApprovals.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as FeatureUsage from "./FeatureUsage.ts";

/** Buffer allowlisted client observations using this socket's attribution and opt-out. */
export const reporter = Effect.fnUntraced(function* (client: FeatureUsage.ClientDimensions) {
  const analytics = yield* AnalyticsService.AnalyticsService;
  return (input: ForkClientUsageInput) => {
    // Each surface reports only the vocabulary its own controls emit.
    const mobileFeature =
      input.feature === "diff-file-review-order" ||
      input.feature === "incoming-share-thread" ||
      input.feature === "mobile-settings" ||
      input.feature === "device-stream-health";
    const reported =
      ((client.surface === "web" || client.surface === "desktop") &&
        input.feature !== "mobile-settings") ||
      (client.surface === "mobile" && mobileFeature);
    if (!reported) return Effect.void;
    if (input.feature === "web-build-update-notice" && client.surface !== "web") {
      return Effect.void;
    }
    if (input.feature === "desktop-update-notice" && client.surface !== "desktop") {
      return Effect.void;
    }
    const attribution = {
      forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION,
      surface: client.surface,
      ...(client.clientOs ? { clientOs: client.clientOs } : {}),
      ...(client.clientAppVersion ? { clientAppVersion: client.clientAppVersion } : {}),
    };
    // Stream quality is not usage either; opening the viewer is already counted by `devices`.
    if (input.feature === "device-stream-health") {
      const { feature: _feature, action: _action, ...summary } = input;
      return analytics
        .record("device.stream.summary", { ...summary, ...attribution })
        .pipe(Effect.ignoreCause);
    }
    // A preference snapshot is not usage; keep it off feature.used dashboards.
    if (input.feature === "client-settings" || input.feature === "mobile-settings") {
      const { feature: _feature, action: _action, ...settings } = input;
      return analytics
        .record("client.settings.snapshot", { ...settings, ...attribution })
        .pipe(Effect.ignoreCause);
    }
    const exposed =
      ((input.feature === "web-build-update-notice" || input.feature === "desktop-update-notice") &&
        input.action === "notice_shown") ||
      (input.feature === "combined-update-confirmation" && input.action === "shown");
    return analytics
      .record(exposed ? "feature.exposed" : "feature.used", {
        ...input,
        source: exposed ? "system" : "user",
        ...attribution,
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
    open: (input, context) =>
      observe(
        {
          feature: "devices",
          action: "open",
          source: "user",
          devicePlatform: input.platform,
          deviceLocation: location(input.hostId),
        },
        service.open(input, context),
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

/** Observe the user's hardware lease and device controls from a client with a surface. */
export const hardware = Effect.fnUntraced(function* (client: FeatureUsage.ClientDimensions) {
  const service = yield* HardwareService.HardwareService;
  const analytics = yield* AnalyticsService.AnalyticsService;
  if (!client.surface) return service;
  const observe = <A, E, R>(
    action: Extract<Parameters<typeof FeatureUsage.observe>[0], { feature: "hardware" }>["action"],
    effect: Effect.Effect<A, E, R>,
  ) =>
    FeatureUsage.observe({ feature: "hardware", action, source: "user" }, effect, client).pipe(
      Effect.provideService(AnalyticsService.AnalyticsService, analytics),
    );
  return HardwareService.HardwareService.of({
    ...service,
    control: (input) =>
      observe(
        input.type === "revoke"
          ? "revoke"
          : input.type === "set-keep"
            ? "keep"
            : input.paused
              ? "pause"
              : "resume",
        service.control(input),
      ),
    configure: (input) =>
      observe(
        input.type === "accept-definition" ? "accept_definition" : "set_credential",
        service.configure(input),
      ),
  });
});

/** Observe the user reviewing, approving and revoking styal.json actions that run on their own. */
export const projectFileApprovals = Effect.fnUntraced(function* (
  client: FeatureUsage.ClientDimensions,
) {
  const service = yield* ProjectFileActionApprovals.ProjectFileActionApprovals;
  const analytics = yield* AnalyticsService.AnalyticsService;
  if (!client.surface) return service;
  const observe = <A, E, R>(
    action: Extract<
      Parameters<typeof FeatureUsage.observe>[0],
      { feature: "project-file-approvals" }
    >["action"],
    effect: Effect.Effect<A, E, R>,
  ) =>
    FeatureUsage.observe(
      { feature: "project-file-approvals", action, source: "user" },
      effect,
      client,
    ).pipe(Effect.provideService(AnalyticsService.AnalyticsService, analytics));
  return ProjectFileActionApprovals.ProjectFileActionApprovals.of({
    ...service,
    review: (input) => observe("review", service.review(input)),
    setApproved: (input) =>
      observe(input.approved ? "approve" : "revoke", service.setApproved(input)),
  });
});

/** Observe the user reviewing the deployments a watched workflow run waits on. */
export const workflowRunReviews = Effect.fnUntraced(function* (
  client: FeatureUsage.ClientDimensions,
) {
  const analytics = yield* AnalyticsService.AnalyticsService;
  return <A, E, R>(reviewState: "approved" | "rejected", effect: Effect.Effect<A, E, R>) =>
    client.surface
      ? FeatureUsage.observe(
          { feature: "workflow-run-watch", action: "review", source: "user", reviewState },
          effect,
          client,
        ).pipe(Effect.provideService(AnalyticsService.AnalyticsService, analytics))
      : effect;
});

/** Observe the user starting Actions runs a pull request's head left waiting for approval. */
export const workflowApprovals = Effect.fnUntraced(function* (
  client: FeatureUsage.ClientDimensions,
) {
  const analytics = yield* AnalyticsService.AnalyticsService;
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    client.surface
      ? FeatureUsage.observe(
          { feature: "workflow-approvals", action: "approve", source: "user" },
          effect,
          client,
        ).pipe(Effect.provideService(AnalyticsService.AnalyticsService, analytics))
      : effect;
});
