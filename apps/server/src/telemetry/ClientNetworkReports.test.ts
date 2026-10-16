import type { ClientNetworkReport } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { recordClientNetworkReports } from "./ClientNetworkReports.ts";

const REPORT: ClientNetworkReport = {
  durationMs: 900_000,
  networkKind: "cellular",
  routeKind: "relay",
  connectedMs: 860_000,
  connectingMs: 40_000,
  offlineMs: 0,
  drops: 2,
  dropsStoppedResponding: 1,
  dropsDisconnected: 0,
  dropsProbeFailed: 1,
  dropsOther: 0,
  failedAttempts: 3,
  setupTimeouts: 1,
  routeSwitches: 2,
  routeSwitchBacks: 1,
  recoveries: 2,
  recoveryMs: [9_000, 31_000],
  heartbeats: 172,
  heartbeatReplies: 170,
  rttP50Ms: 140,
  rttP90Ms: 620,
  rttMaxMs: 4_100,
  bytesReceived: 2_400_000,
  bytesSent: 61_000,
  messagesReceived: 900,
  messagesSent: 410,
  peakReceiveBytesPerSecond: 380_000,
  endedAgoMs: 3_600_000,
};

it.effect("records each report with the client's dimensions, dated when its window ended", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-16T09:00:00.000Z"));
    const recorded: Array<{
      readonly event: string;
      readonly properties: Readonly<Record<string, unknown>> | undefined;
      readonly capturedAt: string | undefined;
    }> = [];
    yield* recordClientNetworkReports(
      { reports: [REPORT, { ...REPORT, networkKind: "wifi", endedAgoMs: 0 }] },
      {
        record: (event, properties, options) =>
          Effect.sync(() => {
            recorded.push({
              event,
              properties,
              capturedAt:
                options?.capturedAt === undefined
                  ? undefined
                  : DateTime.formatIso(options.capturedAt),
            });
          }),
      },
      { surface: "mobile", os: "iOS", appVersion: "1.2.3" },
    );

    const { endedAgoMs: _endedAgoMs, ...metrics } = REPORT;
    assert.deepEqual(recorded, [
      {
        event: "client.network.report",
        properties: {
          surface: "mobile",
          os: "iOS",
          appVersion: "1.2.3",
          ...metrics,
          networkReportVersion: 1,
        },
        capturedAt: "2026-10-16T08:00:00.000Z",
      },
      {
        event: "client.network.report",
        properties: {
          surface: "mobile",
          os: "iOS",
          appVersion: "1.2.3",
          ...metrics,
          networkKind: "wifi",
          networkReportVersion: 1,
        },
        capturedAt: "2026-10-16T09:00:00.000Z",
      },
    ]);
  }),
);
