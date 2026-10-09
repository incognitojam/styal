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
  vpn: "VPN",
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

function plural(count: number, word: string, words = `${word}s`): string {
  return `${count} ${count === 1 ? word : words}`;
}

/** Whether a window had any failure worth drawing attention to. */
export function hadTrouble(metrics: NetworkReportMetrics): boolean {
  return metrics.drops > 0 || metrics.failedAttempts > 0 || metrics.routeSwitchBacks > 0;
}

export interface NetworkReportLine {
  readonly text: string;
  readonly trouble: boolean;
}

function describeDrops(metrics: NetworkReportMetrics): string {
  const causes = (
    [
      [metrics.dropsStoppedResponding, "stopped responding"],
      [metrics.dropsDisconnected, "disconnected"],
      [metrics.dropsProbeFailed, "health check timed out"],
      [metrics.dropsOther, "other"],
    ] as const
  ).filter(([count]) => count > 0);
  const detail =
    causes.length === 1
      ? causes[0]![1]
      : causes.map(([count, cause]) => `${count} ${cause}`).join(", ");
  return `${plural(metrics.drops, "drop")} (${detail})`;
}

/** One line each for availability, failures, route changes, latency and data. */
export function describeNetworkReport(
  metrics: NetworkReportMetrics,
): ReadonlyArray<NetworkReportLine> {
  const lines: Array<NetworkReportLine> = [
    {
      text: `Connected ${connectedPercent(metrics.connectedMs, metrics.durationMs)}% of ${formatDuration(metrics.durationMs)}`,
      trouble: false,
    },
  ];
  // A reconnect can land in the window after its drop, so it shows on its own too.
  if (metrics.drops > 0 || metrics.failedAttempts > 0 || metrics.recoveryMs.length > 0) {
    const failures = [
      ...(metrics.drops > 0 ? [describeDrops(metrics)] : []),
      ...(metrics.failedAttempts > 0
        ? [
            metrics.setupTimeouts > 0
              ? `${plural(metrics.failedAttempts, "failed attempt")} (${metrics.setupTimeouts} timed out)`
              : plural(metrics.failedAttempts, "failed attempt"),
          ]
        : []),
    ];
    const recoveries = [...metrics.recoveryMs].sort((left, right) => left - right);
    if (recoveries.length > 0) {
      const median = recoveries[Math.ceil(recoveries.length / 2) - 1]!;
      const slowest = recoveries[recoveries.length - 1]!;
      failures.push(
        recoveries.length === 1
          ? `${failures.length === 0 ? "Reconnected" : "reconnected"} in ${formatDuration(median)}`
          : `${failures.length === 0 ? "Reconnected" : "reconnected"} in ${formatDuration(median)} (slowest ${formatDuration(slowest)})`,
      );
    }
    lines.push({ text: failures.join(" · "), trouble: true });
  }
  if (metrics.routeSwitches > 0 || metrics.routeSwitchBacks > 0) {
    lines.push({
      text: [
        ...(metrics.routeSwitches > 0
          ? [plural(metrics.routeSwitches, "route switch", "route switches")]
          : []),
        ...(metrics.routeSwitchBacks > 0
          ? [`${plural(metrics.routeSwitchBacks, "switch", "switches")} back after a failure`]
          : []),
      ].join(" · "),
      trouble: metrics.routeSwitchBacks > 0,
    });
  }
  if (metrics.initialConnectMs !== undefined) {
    lines.push({
      text: `First connected after ${formatDuration(metrics.initialConnectMs)}`,
      trouble: false,
    });
  }
  if (
    metrics.rttP50Ms !== undefined &&
    metrics.rttP90Ms !== undefined &&
    metrics.rttMaxMs !== undefined
  ) {
    lines.push({
      text: `Round trip ${formatDuration(metrics.rttP50Ms)} · p90 ${formatDuration(metrics.rttP90Ms)} · max ${formatDuration(metrics.rttMaxMs)}`,
      trouble: false,
    });
  } else if (metrics.heartbeats > 0) {
    lines.push({ text: "No heartbeat answered", trouble: true });
  }
  if (metrics.bytesReceived > 0 || metrics.bytesSent > 0) {
    lines.push({
      text: `Received ${formatBytes(metrics.bytesReceived)} · sent ${formatBytes(metrics.bytesSent)} · peak ${formatBytes(metrics.peakReceiveBytesPerSecond)}/s`,
      trouble: false,
    });
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
