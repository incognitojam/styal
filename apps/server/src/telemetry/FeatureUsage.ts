import type {
  ClientOs,
  ClientSurface,
  DeviceActionType,
  DevicePlatform,
  PreviewAutomationOperation,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import * as AnalyticsService from "./AnalyticsService.ts";

// Extend this union at the feature's entry point. Never pass tool arguments or
// results: usage properties are a fixed vocabulary, independent of user data.
type FeatureUsage =
  | {
      readonly feature: "browser-tools";
      readonly action: PreviewAutomationOperation;
      readonly source: "agent";
    }
  | {
      readonly feature: "devices";
      readonly action: "list" | "open" | "close" | "shutdown" | "snapshot" | DeviceActionType;
      readonly source: "user" | "agent";
      readonly devicePlatform?: DevicePlatform | undefined;
      readonly deviceLocation?: "local" | "remote" | undefined;
    }
  | {
      readonly feature: "notices";
      readonly action: "post" | "list" | "resolve";
      readonly source: "user" | "agent";
    };

export interface ClientDimensions {
  readonly surface?: ClientSurface | undefined;
  readonly clientOs?: ClientOs | undefined;
  readonly clientAppVersion?: string | undefined;
}

function deviceFailureReason(cause: Cause.Cause<unknown>) {
  const error = Cause.findErrorOption(cause);
  const tag =
    Option.isSome(error) &&
    typeof error.value === "object" &&
    error.value !== null &&
    "_tag" in error.value
      ? error.value._tag
      : undefined;
  switch (tag) {
    case "DeviceToolUnavailableError":
    case "DeviceHostUnavailableError":
    case "DevicePlatformUnavailableError":
      return "unavailable";
    case "DeviceNotFoundError":
      return "not_found";
    default:
      return "operation_failed";
  }
}

/** Observe one public operation, preserving its result, failure and interruption. */
export const observe = <A, E, R>(
  usage: FeatureUsage,
  effect: Effect.Effect<A, E, R>,
  client: ClientDimensions = {},
) =>
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
            ...(usage.feature === "devices" &&
            Exit.isFailure(exit) &&
            !Cause.hasInterruptsOnly(exit.cause)
              ? { failureReason: deviceFailureReason(exit.cause) }
              : {}),
            ...(usage.feature === "devices"
              ? {
                  ...(usage.devicePlatform ? { devicePlatform: usage.devicePlatform } : {}),
                  ...(usage.deviceLocation ? { deviceLocation: usage.deviceLocation } : {}),
                }
              : {}),
            ...(client.surface ? { surface: client.surface } : {}),
            ...(client.clientOs ? { clientOs: client.clientOs } : {}),
            ...(client.clientAppVersion ? { clientAppVersion: client.clientAppVersion } : {}),
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
