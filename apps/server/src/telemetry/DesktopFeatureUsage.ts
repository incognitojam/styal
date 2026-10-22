import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

/**
 * Records the desktop app's usage observations as `feature.used` events. The
 * desktop main process has no analytics of its own, so it reports through the
 * telemetry pipe of the backend it spawned, under that server's identity and
 * telemetry setting.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
    const analytics = yield* AnalyticsService.AnalyticsService;
    yield* receiver.desktopFeatureUsage.pipe(
      Stream.runForEach((report) =>
        analytics
          .record("feature.used", {
            feature: report.feature,
            action: report.action,
            source: "system",
            updateVersion: report.updateVersion,
            delayBucket: report.delayBucket,
          })
          .pipe(Effect.ignoreCause),
      ),
      Effect.forkScoped,
    );
  }),
);
