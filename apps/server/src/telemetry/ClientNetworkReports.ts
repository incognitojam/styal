import type { ReportNetworkConditionsInput } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as AnalyticsService from "./AnalyticsService.ts";

/** Bumped when the meaning of a `client.network.report` property changes. */
const NETWORK_REPORT_VERSION = 1;

/**
 * Records each report as a `client.network.report` event dated when its window
 * ended. A client sends reports from a dead zone only after reconnecting, so
 * the delivery time would place them in the wrong period.
 */
export const recordClientNetworkReports = Effect.fnUntraced(function* (
  input: ReportNetworkConditionsInput,
  analytics: Pick<AnalyticsService.AnalyticsService["Service"], "record">,
  client: Readonly<Record<string, unknown>>,
) {
  const now = yield* DateTime.now;
  yield* Effect.forEach(
    input.reports,
    ({ endedAgoMs, ...metrics }) =>
      analytics.record(
        "client.network.report",
        { ...client, ...metrics, networkReportVersion: NETWORK_REPORT_VERSION },
        { capturedAt: DateTime.subtract(now, { milliseconds: endedAgoMs }) },
      ),
    { discard: true },
  );
});
