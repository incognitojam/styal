import type { DesktopFeatureUsageReport } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

const toAnalyticsEvent = (report: DesktopFeatureUsageReport) => {
  if (report.feature === "desktop-update-idle-restart") {
    return {
      event: "feature.used",
      properties: {
        feature: report.feature,
        action: report.action,
        source: "system",
        updateVersion: report.updateVersion,
        delayBucket: report.delayBucket,
      },
    };
  }
  return {
    event: "desktop.launched",
    properties: {
      desktopPlatform: report.platform,
      launchKind: report.update === undefined ? "normal" : "update",
      backendReadyMs: report.backendReadyMs,
      windowShownMs: report.windowShownMs,
      ...(report.update === undefined
        ? {}
        : {
            updateStopMs: report.update.stopMs,
            updateRelaunchMs: report.update.relaunchMs,
            updateTotalMs: report.update.stopMs + report.update.relaunchMs + report.windowShownMs,
            stagedInBackground: report.update.stagedInBackground,
          }),
    },
  };
};

/**
 * The desktop main process has no analytics of its own, so it reports through the telemetry
 * pipe of the backend it spawned, under that server's identity and telemetry setting.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
    const analytics = yield* AnalyticsService.AnalyticsService;
    yield* receiver.desktopFeatureUsage.pipe(
      Stream.runForEach((report) => {
        const { event, properties } = toAnalyticsEvent(report);
        return analytics.record(event, properties).pipe(Effect.ignoreCause);
      }),
      Effect.forkScoped,
    );
  }),
);
