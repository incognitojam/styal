import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

/** The device's network interface type. Never a network or carrier name. */
export const NetworkReportNetworkKind = Schema.Literals([
  "wifi",
  "cellular",
  "ethernet",
  "vpn",
  "other",
  "none",
  "unknown",
]);
export type NetworkReportNetworkKind = typeof NetworkReportNetworkKind.Type;

/** How the client reached the environment. Connections to the same device are not reported. */
export const NetworkReportRouteKind = Schema.Literals([
  "relay",
  "lan",
  "tailnet",
  "public",
  "ssh",
  "unknown",
]);
export type NetworkReportRouteKind = typeof NetworkReportRouteKind.Type;

/**
 * One window of foreground use of one environment under a single network type
 * and route. Durations are milliseconds; byte counts are message payload sizes
 * before WebSocket compression.
 */
export const NetworkReportMetrics = Schema.Struct({
  durationMs: NonNegativeInt,
  networkKind: NetworkReportNetworkKind,
  routeKind: NetworkReportRouteKind,
  connectedMs: NonNegativeInt,
  connectingMs: NonNegativeInt,
  offlineMs: NonNegativeInt,
  /**
   * Time until a working connection when the window started without one, such
   * as after the network came back or when the session died in the background.
   */
  initialConnectMs: Schema.optionalKey(NonNegativeInt),
  /** Sessions that stopped working after answering in the foreground. */
  drops: NonNegativeInt,
  /** Drops after heartbeats went unanswered and the client closed the socket. */
  dropsStoppedResponding: NonNegativeInt,
  /** Drops where the socket closed. */
  dropsDisconnected: NonNegativeInt,
  /** Drops where a health check, run on returning to the app or a network change, timed out. */
  dropsProbeFailed: NonNegativeInt,
  dropsOther: NonNegativeInt,
  failedAttempts: NonNegativeInt,
  /** Failed attempts that ran out of time before the session was ready. */
  setupTimeouts: NonNegativeInt,
  /** New sessions on a different route after the previous one ended without failing, usually a better route. */
  routeSwitches: NonNegativeInt,
  /** Returns to the route switched away from, after the switched-to session failed. */
  routeSwitchBacks: NonNegativeInt,
  /** Connections restored after a drop, and how long each took from the drop. */
  recoveries: NonNegativeInt,
  recoveryP50Ms: Schema.optionalKey(NonNegativeInt),
  recoveryMaxMs: Schema.optionalKey(NonNegativeInt),
  heartbeats: NonNegativeInt,
  heartbeatReplies: NonNegativeInt,
  rttP50Ms: Schema.optionalKey(NonNegativeInt),
  rttP90Ms: Schema.optionalKey(NonNegativeInt),
  rttMaxMs: Schema.optionalKey(NonNegativeInt),
  bytesReceived: NonNegativeInt,
  bytesSent: NonNegativeInt,
  messagesReceived: NonNegativeInt,
  messagesSent: NonNegativeInt,
  peakReceiveBytesPerSecond: NonNegativeInt,
});
export type NetworkReportMetrics = typeof NetworkReportMetrics.Type;

export const MAX_NETWORK_REPORT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const ClientNetworkReport = Schema.Struct({
  ...NetworkReportMetrics.fields,
  /** How long before sending the window ended, so client and server clocks need not agree. */
  endedAgoMs: NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_NETWORK_REPORT_AGE_MS)),
});
export type ClientNetworkReport = typeof ClientNetworkReport.Type;

export const MAX_NETWORK_REPORTS_PER_REQUEST = 50;

export const ReportNetworkConditionsInput = Schema.Struct({
  reports: Schema.Array(ClientNetworkReport).check(
    Schema.isMaxLength(MAX_NETWORK_REPORTS_PER_REQUEST),
  ),
});
export type ReportNetworkConditionsInput = typeof ReportNetworkConditionsInput.Type;
