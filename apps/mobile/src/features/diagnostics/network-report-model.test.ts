import type { NetworkReportMetrics } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeNetworkReport, summarizeByNetworkKind } from "./network-report-model";

const QUIET: NetworkReportMetrics = {
  durationMs: 600_000,
  networkKind: "wifi",
  routeKind: "lan",
  connectedMs: 600_000,
  connectingMs: 0,
  offlineMs: 0,
  drops: 0,
  heartbeatTimeouts: 0,
  failedAttempts: 0,
  recoveries: 0,
  heartbeats: 0,
  heartbeatReplies: 0,
  bytesReceived: 0,
  bytesSent: 0,
  messagesReceived: 0,
  messagesSent: 0,
  peakReceiveBytesPerSecond: 0,
};

const TRAIN: NetworkReportMetrics = {
  ...QUIET,
  durationMs: 900_000,
  networkKind: "cellular",
  routeKind: "relay",
  connectedMs: 855_000,
  connectingMs: 45_000,
  drops: 2,
  heartbeatTimeouts: 1,
  recoveries: 2,
  recoveryP50Ms: 8_000,
  recoveryMaxMs: 31_000,
  heartbeats: 170,
  heartbeatReplies: 168,
  rttP50Ms: 140,
  rttP90Ms: 620,
  rttMaxMs: 4_100,
  bytesReceived: 2_400_000,
  bytesSent: 61_000,
  peakReceiveBytesPerSecond: 380_000,
};

describe("describeNetworkReport", () => {
  it("lists drops, recovery, round trips and data for a window with outages", () => {
    expect(describeNetworkReport(TRAIN)).toEqual([
      "Connected 95% of 15m",
      "2 drops · 1 heartbeat timeout · reconnected in 8.0s (slowest 31s)",
      "Round trip 140ms · p90 620ms · max 4.1s",
      "Received 2.3 MB · sent 60 KB · peak 371 KB/s",
    ]);
  });

  it("reports a window that never got a heartbeat answer", () => {
    expect(
      describeNetworkReport({
        ...QUIET,
        connectedMs: 0,
        connectingMs: 600_000,
        heartbeats: 3,
        failedAttempts: 4,
      }),
    ).toEqual(["Connected 0% of 10m", "4 failed attempts", "No heartbeat answered"]);
  });

  it("does not round a window with an outage up to 100%", () => {
    expect(describeNetworkReport({ ...QUIET, connectedMs: 599_000 })[0]).toBe(
      "Connected 99% of 10m",
    );
  });
});

describe("summarizeByNetworkKind", () => {
  it("totals each network type, the most used first", () => {
    expect(
      summarizeByNetworkKind([
        { metrics: QUIET },
        { metrics: TRAIN },
        { metrics: { ...TRAIN, connectedMs: 900_000, drops: 0 } },
      ]),
    ).toEqual([
      { networkKind: "cellular", durationMs: 1_800_000, connectedPercent: 97, drops: 2 },
      { networkKind: "wifi", durationMs: 600_000, connectedPercent: 100, drops: 0 },
    ]);
  });
});
