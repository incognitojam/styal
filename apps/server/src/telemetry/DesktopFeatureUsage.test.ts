import { expect, it } from "@effect/vitest";
import type { DesktopFeatureUsageReport, DesktopIdleRestartDelayBucket } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as DesktopFeatureUsage from "./DesktopFeatureUsage.ts";

const report = (
  updateVersion: string,
  delayBucket: DesktopIdleRestartDelayBucket,
): DesktopFeatureUsageReport => ({
  version: 1,
  type: "desktopFeatureUsage",
  feature: "desktop-update-idle-restart",
  action: "would_restart",
  updateVersion,
  delayBucket,
});

it.effect("records each desktop usage report as one feature.used event", () =>
  Effect.gen(function* () {
    const events: Array<unknown> = [];
    const recorded = yield* Deferred.make<void>();
    const analytics = AnalyticsService.AnalyticsService.of({
      recordOwners: () => Effect.void,
      record: (event, properties) =>
        Effect.suspend(() => {
          events.push({ event, properties });
          return events.length === 2 ? Deferred.succeed(recorded, undefined) : Effect.void;
        }).pipe(Effect.asVoid),
      flush: Effect.void,
    });
    yield* Layer.build(
      DesktopFeatureUsage.layer.pipe(
        Layer.provide(
          DesktopTelemetryReceiver.layerTest({
            desktopFeatureUsage: Stream.make(report("1.2.4", "1-8h"), report("1.2.3", "never")),
          }),
        ),
        Layer.provide(Layer.succeed(AnalyticsService.AnalyticsService, analytics)),
      ),
    );
    yield* Deferred.await(recorded);
    expect(events).toEqual([
      {
        event: "feature.used",
        properties: {
          feature: "desktop-update-idle-restart",
          action: "would_restart",
          source: "system",
          updateVersion: "1.2.4",
          delayBucket: "1-8h",
        },
      },
      {
        event: "feature.used",
        properties: {
          feature: "desktop-update-idle-restart",
          action: "would_restart",
          source: "system",
          updateVersion: "1.2.3",
          delayBucket: "never",
        },
      },
    ]);
  }),
);

it.effect("records desktop launch timing as desktop.launched events", () =>
  Effect.gen(function* () {
    const events: Array<unknown> = [];
    const recorded = yield* Deferred.make<void>();
    const analytics = AnalyticsService.AnalyticsService.of({
      recordOwners: () => Effect.void,
      record: (event, properties) =>
        Effect.suspend(() => {
          events.push({ event, properties });
          return events.length === 2 ? Deferred.succeed(recorded, undefined) : Effect.void;
        }).pipe(Effect.asVoid),
      flush: Effect.void,
    });
    const launch = {
      version: 1,
      type: "desktopFeatureUsage",
      feature: "desktop-launch",
      action: "launched",
      platform: "win32",
      backendReadyMs: 2_100,
      windowShownMs: 2_600,
    } as const;
    yield* Layer.build(
      DesktopFeatureUsage.layer.pipe(
        Layer.provide(
          DesktopTelemetryReceiver.layerTest({
            desktopFeatureUsage: Stream.make(launch, {
              ...launch,
              update: { stopMs: 900, relaunchMs: 7_400, stagedInBackground: false },
            }),
          }),
        ),
        Layer.provide(Layer.succeed(AnalyticsService.AnalyticsService, analytics)),
      ),
    );
    yield* Deferred.await(recorded);
    expect(events).toEqual([
      {
        event: "desktop.launched",
        properties: {
          desktopPlatform: "win32",
          launchKind: "normal",
          backendReadyMs: 2_100,
          windowShownMs: 2_600,
        },
      },
      {
        event: "desktop.launched",
        properties: {
          desktopPlatform: "win32",
          launchKind: "update",
          backendReadyMs: 2_100,
          windowShownMs: 2_600,
          updateStopMs: 900,
          updateRelaunchMs: 7_400,
          updateTotalMs: 10_900,
          stagedInBackground: false,
        },
      },
    ]);
  }),
);
