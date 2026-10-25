import type { DevicePlatform, ForkClientUsageInput } from "@t3tools/contracts";

/**
 * Separates lag from dropouts: growing delay means frames queue between device and viewer,
 * decoder resets mean the viewer could not decode fast enough, and stalls or reconnects point
 * at the connection.
 */
export type DeviceStreamTransport = "h264" | "avcc" | "mjpeg";

export interface DeviceStreamStats {
  readonly transport: DeviceStreamTransport;
  readonly elapsedMs: number;
  readonly framesShown: number;
  /** Frames shown in the last second. */
  readonly fps: number;
  /** Video received in the last second, in kilobits per second; null for MJPEG. */
  readonly receivedKbps: number | null;
  /**
   * Lag of the least-delayed frame in the last second over the smallest lag since the stream
   * (re)started, because a queue delays every frame. Null on a still screen, where the encoder
   * holds sparse frames, and when the stream carries no timestamps.
   */
  readonly addedDelayMs: number | null;
  readonly maxAddedDelayMs: number | null;
  readonly decoderResets: number;
  readonly reconnects: number;
  /** Gaps of at least `STALL_GAP_MS` without video; null where a still screen sends no video. */
  readonly stalls: number | null;
  readonly longestGapMs: number | null;
}

/**
 * The Android encoder keeps sending frames while the screen is still, measured
 * at up to about one second apart, so two seconds without video means the
 * stream stopped moving. iOS streams send nothing while the screen is still,
 * so their gaps say nothing.
 */
export const STALL_GAP_MS = 2_000;
const WINDOW_MS = 1_000;
/** Fewer frames than this in a second means the screen is still. */
const MOVING_FRAMES = 5;

export interface DeviceStreamStatsTracker {
  readonly setTransport: (transport: DeviceStreamTransport) => void;
  /** `timestampUs` is the device's capture time for the frame, when the stream carries it. */
  readonly videoReceived: (bytes: number, timestampUs: number | null) => void;
  readonly frameShown: () => void;
  readonly decoderReset: () => void;
  readonly reconnected: () => void;
  /** Device timestamps restart with a new encoder session or connection. */
  readonly restartTiming: () => void;
  readonly snapshot: () => DeviceStreamStats;
}

export function createDeviceStreamStatsTracker(
  transport: DeviceStreamTransport,
  now: () => number = () => performance.now(),
): DeviceStreamStatsTracker {
  const startedAt = now();
  let currentTransport = transport;
  let framesShown = 0;
  let decoderResets = 0;
  let reconnects = 0;
  let stalls = 0;
  let longestGapMs = 0;
  let lastVideoAt: number | null = null;
  let baselineOffsetMs: number | null = null;
  let maxAddedDelayMs: number | null = null;
  const shownAt: number[] = [];
  const received: Array<{ readonly at: number; readonly bytes: number }> = [];
  const offsets: Array<{ readonly at: number; readonly offsetMs: number }> = [];

  const trim = (at: number) => {
    while (shownAt.length > 0 && at - shownAt[0]! > WINDOW_MS) shownAt.shift();
    while (received.length > 0 && at - received[0]!.at > WINDOW_MS) received.shift();
    while (offsets.length > 0 && at - offsets[0]!.at > WINDOW_MS) offsets.shift();
  };
  const addedDelay = () =>
    baselineOffsetMs === null || offsets.length < MOVING_FRAMES
      ? null
      : Math.min(...offsets.map((entry) => entry.offsetMs)) - baselineOffsetMs;

  return {
    setTransport: (next) => {
      currentTransport = next;
    },
    videoReceived: (bytes, timestampUs) => {
      const at = now();
      if (lastVideoAt !== null && currentTransport === "h264") {
        const gap = at - lastVideoAt;
        if (gap >= STALL_GAP_MS) stalls++;
        longestGapMs = Math.max(longestGapMs, gap);
      }
      lastVideoAt = at;
      received.push({ at, bytes });
      if (timestampUs !== null) {
        // Arrival time minus capture time is the lag plus an unknown clock
        // offset; its smallest value approximates the offset alone.
        const offsetMs = at - timestampUs / 1_000;
        baselineOffsetMs =
          baselineOffsetMs === null ? offsetMs : Math.min(baselineOffsetMs, offsetMs);
        offsets.push({ at, offsetMs });
      }
      trim(at);
      const delay = addedDelay();
      if (delay !== null) maxAddedDelayMs = Math.max(maxAddedDelayMs ?? 0, delay);
    },
    frameShown: () => {
      const at = now();
      framesShown++;
      shownAt.push(at);
      trim(at);
    },
    decoderReset: () => {
      decoderResets++;
    },
    reconnected: () => {
      reconnects++;
    },
    restartTiming: () => {
      baselineOffsetMs = null;
      offsets.length = 0;
      lastVideoAt = null;
    },
    snapshot: () => {
      const at = now();
      trim(at);
      const bytes = received.reduce((total, entry) => total + entry.bytes, 0);
      return {
        transport: currentTransport,
        elapsedMs: at - startedAt,
        framesShown,
        fps: shownAt.length,
        receivedKbps: currentTransport === "mjpeg" ? null : (bytes * 8) / WINDOW_MS,
        addedDelayMs: addedDelay(),
        maxAddedDelayMs,
        decoderResets,
        reconnects,
        stalls: currentTransport === "h264" ? stalls : null,
        longestGapMs: currentTransport === "h264" ? longestGapMs : null,
      };
    },
  };
}

const TRANSPORT_LABELS: Record<DeviceStreamTransport, string> = {
  h264: "H.264 over WebSocket",
  avcc: "H.264 over HTTP",
  mjpeg: "MJPEG",
};

const milliseconds = (value: number | null, missing = "Not reported") =>
  value === null ? missing : `${Math.round(value)} ms`;

/** Label and value rows shared by the web and mobile stats views. */
export function deviceStreamStatsRows(
  stats: DeviceStreamStats,
): ReadonlyArray<readonly [string, string]> {
  return [
    ["Video", TRANSPORT_LABELS[stats.transport]],
    ["Frames per second", String(stats.fps)],
    [
      "Received",
      stats.receivedKbps === null ? "Not reported" : `${Math.round(stats.receivedKbps)} kbit/s`,
    ],
    [
      "Delay behind device",
      milliseconds(stats.addedDelayMs, stats.transport === "h264" ? "Screen still" : undefined),
    ],
    ["Largest delay", milliseconds(stats.maxAddedDelayMs)],
    ["Decoder resets", String(stats.decoderResets)],
    ["Reconnects", String(stats.reconnects)],
    ["Pauses over 2 s", stats.stalls === null ? "Not reported" : String(stats.stalls)],
    ["Longest pause", milliseconds(stats.longestGapMs)],
    ["Frames shown", String(stats.framesShown)],
  ];
}

/** Shorter sessions are mostly a viewer opened and closed again; they say little about quality. */
const MIN_REPORTED_SESSION_MS = 5_000;

const isLoopbackUrl = (url: string) => {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || host.startsWith("127.");
  } catch {
    return false;
  }
};

/** The end-of-stream usage report, or null when the stream never showed video for long. */
export function deviceStreamUsageSummary(
  stats: DeviceStreamStats,
  platform: DevicePlatform,
  wsBase: string,
): Extract<ForkClientUsageInput, { feature: "device-stream-health" }> | null {
  if (stats.framesShown === 0 || stats.elapsedMs < MIN_REPORTED_SESSION_MS) return null;
  const round = (value: number | null) => (value === null ? null : Math.round(value));
  return {
    feature: "device-stream-health",
    action: "session_ended",
    platform,
    transport: stats.transport,
    connection: isLoopbackUrl(wsBase) ? "loopback" : "network",
    durationSeconds: Math.round(stats.elapsedMs / 1_000),
    averageFps: Math.round((stats.framesShown * 1_000) / stats.elapsedMs),
    decoderResets: stats.decoderResets,
    reconnects: stats.reconnects,
    stalls: stats.stalls,
    longestGapMs: round(stats.longestGapMs),
    maxAddedDelayMs: round(stats.maxAddedDelayMs),
  };
}
