import type {
  NetworkReportMetrics,
  NetworkReportNetworkKind,
  NetworkReportRouteKind,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

const NETWORK_KIND_LABELS: Record<NetworkReportNetworkKind, string> = {
  wifi: "Wi-Fi",
  cellular: "Cellular",
  ethernet: "Ethernet",
  vpn: "VPN",
  other: "Other network",
  none: "No network",
  unknown: "Unknown network",
};

const ROUTE_KIND_LABELS: Record<NetworkReportRouteKind, string> = {
  relay: "styal Link",
  lan: "LAN",
  tailnet: "Tailscale",
  public: "Public address",
  ssh: "SSH",
  unknown: "No connection yet",
};

export function networkKindLabel(kind: NetworkReportNetworkKind): string {
  return NETWORK_KIND_LABELS[kind];
}

export function routeKindLabel(kind: NetworkReportRouteKind): string {
  return ROUTE_KIND_LABELS[kind];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

// Rounded down, so a window with any outage never reads as 100%.
function connectedPercent(connectedMs: number, durationMs: number): number {
  return durationMs <= 0 ? 0 : Math.floor((connectedMs / durationMs) * 100);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Whether a window had any failure worth drawing attention to. */
export function hadTrouble(metrics: NetworkReportMetrics): boolean {
  return metrics.drops > 0 || metrics.failedAttempts > 0 || metrics.heartbeatTimeouts > 0;
}

/** One line each for availability, failures, latency and data. */
export function describeNetworkReport(metrics: NetworkReportMetrics): ReadonlyArray<string> {
  const lines = [
    `Connected ${connectedPercent(metrics.connectedMs, metrics.durationMs)}% of ${formatDuration(metrics.durationMs)}`,
  ];
  if (hadTrouble(metrics)) {
    const failures = [
      ...(metrics.drops > 0 ? [plural(metrics.drops, "drop")] : []),
      ...(metrics.failedAttempts > 0 ? [plural(metrics.failedAttempts, "failed attempt")] : []),
      ...(metrics.heartbeatTimeouts > 0
        ? [plural(metrics.heartbeatTimeouts, "heartbeat timeout")]
        : []),
    ];
    if (metrics.recoveryP50Ms !== undefined && metrics.recoveryMaxMs !== undefined) {
      failures.push(
        metrics.recoveries === 1
          ? `reconnected in ${formatDuration(metrics.recoveryP50Ms)}`
          : `reconnected in ${formatDuration(metrics.recoveryP50Ms)} (slowest ${formatDuration(metrics.recoveryMaxMs)})`,
      );
    }
    lines.push(failures.join(" · "));
  }
  if (metrics.initialConnectMs !== undefined) {
    lines.push(`First connected after ${formatDuration(metrics.initialConnectMs)}`);
  }
  if (
    metrics.rttP50Ms !== undefined &&
    metrics.rttP90Ms !== undefined &&
    metrics.rttMaxMs !== undefined
  ) {
    lines.push(
      `Round trip ${formatDuration(metrics.rttP50Ms)} · p90 ${formatDuration(metrics.rttP90Ms)} · max ${formatDuration(metrics.rttMaxMs)}`,
    );
  } else if (metrics.heartbeats > 0) {
    lines.push("No heartbeat answered");
  }
  if (metrics.bytesReceived > 0 || metrics.bytesSent > 0) {
    lines.push(
      `Received ${formatBytes(metrics.bytesReceived)} · sent ${formatBytes(metrics.bytesSent)} · peak ${formatBytes(metrics.peakReceiveBytesPerSecond)}/s`,
    );
  }
  return lines;
}

export interface NetworkKindSummary {
  readonly networkKind: NetworkReportNetworkKind;
  readonly durationMs: number;
  readonly connectedPercent: number;
  readonly drops: number;
}

/** Totals per network type, the most used first. */
export function summarizeByNetworkKind(
  reports: ReadonlyArray<{ readonly metrics: NetworkReportMetrics }>,
): ReadonlyArray<NetworkKindSummary> {
  const totals = new Map<
    NetworkReportNetworkKind,
    { durationMs: number; connectedMs: number; drops: number }
  >();
  for (const { metrics } of reports) {
    const current = totals.get(metrics.networkKind) ?? { durationMs: 0, connectedMs: 0, drops: 0 };
    current.durationMs += metrics.durationMs;
    current.connectedMs += metrics.connectedMs;
    current.drops += metrics.drops;
    totals.set(metrics.networkKind, current);
  }
  return [...totals]
    .map(([networkKind, total]) => ({
      networkKind,
      durationMs: total.durationMs,
      connectedPercent: connectedPercent(total.connectedMs, total.durationMs),
      drops: total.drops,
    }))
    .sort((left, right) => right.durationMs - left.durationMs);
}

/** When a window started: the time today, otherwise with the date. Its length is in the summary. */
export function formatReportStart(startedAt: number, now: number): string {
  const started = new Date(startedAt);
  const time = started.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return started.toDateString() === new Date(now).toDateString()
    ? time
    : `${started.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}
