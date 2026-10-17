import {
  type EnvironmentId,
  MAX_RECOVERY_SAMPLES,
  type NetworkReportMetrics,
  type NetworkReportNetworkKind,
} from "@t3tools/contracts";
import { RpcMessage } from "effect/rpc";
import type * as Socket from "effect/socket/Socket";

import type {
  ConnectionAttemptError,
  SupervisorConnectionPhase,
  SupervisorConnectionState,
} from "../connection/model.ts";
import type { ConnectionRouteKind } from "../connection/routes.ts";

/** A window closes after this long even when nothing about the connection changed. */
export const NETWORK_REPORT_WINDOW_MS = 15 * 60_000;
// Shorter windows without a failure are the gaps between quick network or
// app switches, and would only add noise.
const MIN_REPORTED_WINDOW_MS = 5_000;

export interface NetworkReportRecord {
  readonly environmentId: EnvironmentId;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly metrics: NetworkReportMetrics;
}

type DropCause = "stoppedResponding" | "disconnected" | "probeFailed" | "other";

/**
 * Why a live session ended. The client closes the socket itself after
 * heartbeats go unanswered, so that is known before the close arrives. While
 * connected, the only timeout is the supervisor's health check.
 */
function dropCause(error: ConnectionAttemptError, heartbeatTimedOut: boolean): DropCause {
  if (heartbeatTimedOut) return "stoppedResponding";
  if (error._tag !== "ConnectionTransientError") return "other";
  switch (error.reason) {
    case "timeout":
      return "probeFailed";
    case "transport":
      return "disconnected";
    default:
      return "other";
  }
}

/** Counts one environment session's traffic. Created for each socket the session opens. */
export interface SocketMeter {
  readonly attach: (socket: Socket.WebSocketLike) => void;
  readonly opened: () => void;
  readonly heartbeatTimedOut: () => void;
}

// Effect RPC heartbeats, as the JSON serialization writes them. The client
// sends a ping every few seconds and the server answers each in order.
const PING_FRAME = JSON.stringify(RpcMessage.constPing);
const PONG_FRAME = JSON.stringify(RpcMessage.constPong);

class ReportWindow {
  connectedMs = 0;
  connectingMs = 0;
  offlineMs = 0;
  initialConnectMs: number | undefined;
  readonly drops: Record<DropCause, number> = {
    stoppedResponding: 0,
    disconnected: 0,
    probeFailed: 0,
    other: 0,
  };
  failedAttempts = 0;
  setupTimeouts = 0;
  routeSwitches = 0;
  routeSwitchBacks = 0;
  readonly recoveries: Array<number> = [];
  heartbeats = 0;
  heartbeatReplies = 0;
  readonly rtts: Array<number> = [];
  bytesReceived = 0;
  bytesSent = 0;
  messagesReceived = 0;
  messagesSent = 0;
  peakReceiveBytesPerSecond = 0;
  private receiveSecond = -1;
  private receiveSecondBytes = 0;
  readonly startedAt: number;
  readonly networkKind: NetworkReportNetworkKind;
  routeKind: ConnectionRouteKind | null;
  // Set while the window waits for a working connection: it started without
  // one, or its session turned out to have died while the app was away.
  awaitingConnection: boolean;
  phaseSince: number;

  constructor(
    startedAt: number,
    networkKind: NetworkReportNetworkKind,
    routeKind: ConnectionRouteKind | null,
    startedDisconnected: boolean,
  ) {
    this.startedAt = startedAt;
    this.networkKind = networkKind;
    this.routeKind = routeKind;
    this.awaitingConnection = startedDisconnected;
    this.phaseSince = startedAt;
  }

  addPhaseTime(phase: SupervisorConnectionPhase, now: number) {
    const elapsed = Math.max(0, now - this.phaseSince);
    this.phaseSince = now;
    switch (phase) {
      case "connected":
        this.connectedMs += elapsed;
        return;
      case "connecting":
      case "backoff":
        this.connectingMs += elapsed;
        return;
      case "offline":
        this.offlineMs += elapsed;
        return;
      case "available":
      case "blocked":
        return;
    }
  }

  received(bytes: number, now: number) {
    this.bytesReceived += bytes;
    this.messagesReceived += 1;
    const second = Math.floor(now / 1_000);
    if (second !== this.receiveSecond) {
      this.receiveSecond = second;
      this.receiveSecondBytes = 0;
    }
    this.receiveSecondBytes += bytes;
    if (this.receiveSecondBytes > this.peakReceiveBytesPerSecond) {
      this.peakReceiveBytesPerSecond = this.receiveSecondBytes;
    }
  }

  get dropCount(): number {
    const { stoppedResponding, disconnected, probeFailed, other } = this.drops;
    return stoppedResponding + disconnected + probeFailed + other;
  }

  isWorthReporting(endedAt: number): boolean {
    if (this.routeKind === "loopback") return false;
    return (
      endedAt - this.startedAt >= MIN_REPORTED_WINDOW_MS ||
      this.dropCount > 0 ||
      this.failedAttempts > 0 ||
      this.routeSwitchBacks > 0
    );
  }

  metrics(endedAt: number): NetworkReportMetrics {
    const rtts = sorted(this.rtts);
    return {
      durationMs: Math.round(endedAt - this.startedAt),
      networkKind: this.networkKind,
      routeKind:
        this.routeKind === null || this.routeKind === "loopback" ? "unknown" : this.routeKind,
      connectedMs: Math.round(this.connectedMs),
      connectingMs: Math.round(this.connectingMs),
      offlineMs: Math.round(this.offlineMs),
      ...(this.initialConnectMs === undefined
        ? {}
        : { initialConnectMs: Math.round(this.initialConnectMs) }),
      drops: this.dropCount,
      dropsStoppedResponding: this.drops.stoppedResponding,
      dropsDisconnected: this.drops.disconnected,
      dropsProbeFailed: this.drops.probeFailed,
      dropsOther: this.drops.other,
      failedAttempts: this.failedAttempts,
      setupTimeouts: this.setupTimeouts,
      routeSwitches: this.routeSwitches,
      routeSwitchBacks: this.routeSwitchBacks,
      recoveries: this.recoveries.length,
      recoveryMs: this.recoveries.slice(0, MAX_RECOVERY_SAMPLES).map(Math.round),
      heartbeats: this.heartbeats,
      heartbeatReplies: this.heartbeatReplies,
      ...(rtts.length === 0
        ? {}
        : {
            rttP50Ms: percentile(rtts, 0.5),
            rttP90Ms: percentile(rtts, 0.9),
            rttMaxMs: percentile(rtts, 1),
          }),
      bytesReceived: this.bytesReceived,
      bytesSent: this.bytesSent,
      messagesReceived: this.messagesReceived,
      messagesSent: this.messagesSent,
      peakReceiveBytesPerSecond: this.peakReceiveBytesPerSecond,
    };
  }
}

function sorted(values: ReadonlyArray<number>): Array<number> {
  return [...values].sort((left, right) => left - right);
}

// Nearest-rank percentile of an ascending, non-empty list.
function percentile(values: ReadonlyArray<number>, fraction: number): number {
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(fraction * values.length) - 1));
  return Math.round(values[index]!);
}

// Text frames count UTF-16 code units rather than encoded bytes. The protocol
// is JSON and mostly ASCII, and encoding every frame to count it would cost
// more than the measurement is worth.
function payloadSize(data: unknown): number {
  if (typeof data === "string") return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return 0;
}

interface EnvironmentTracker {
  phase: SupervisorConnectionPhase;
  desired: boolean;
  // The session answered since the app last came to the foreground. A socket
  // that dies in the background is only found on return, which is not a drop
  // the user saw.
  answered: boolean;
  // Set by the client's own heartbeat timeout, which closes the socket just
  // before the supervisor reports the failure.
  heartbeatTimedOut: boolean;
  // The route of the latest session, and whether that session has failed.
  routeId: string | null;
  sessionFailed: boolean;
  // The route left by the last switch, until the switched-to session fails
  // and the connection returns to it or settles elsewhere.
  switchedFrom: string | null;
  // Compared by identity: the supervisor keeps reporting the same failure
  // while it waits and retries, and creates a new one for each failure.
  lastFailure: ConnectionAttemptError | null;
  // The route of the latest session, assumed until a new session says otherwise.
  routeKind: ConnectionRouteKind | null;
  droppedAt: number | null;
  window: ReportWindow | null;
}

/**
 * Splits each environment's connection into report windows, one per stretch of
 * foreground use with the same network type and route, and summarizes each.
 * Calls are synchronous because socket events arrive outside Effect.
 */
export class NetworkReportCollector {
  private active = true;
  private networkKind: NetworkReportNetworkKind = "unknown";
  private readonly trackers = new Map<EnvironmentId, EnvironmentTracker>();
  private readonly options: {
    readonly now: () => number;
    readonly report: (record: NetworkReportRecord) => void;
  };

  constructor(options: NetworkReportCollector["options"]) {
    this.options = options;
  }

  /** The app is in the foreground. Windows only cover foreground time. */
  setActive(active: boolean) {
    if (active === this.active) return;
    this.active = active;
    const now = this.options.now();
    for (const [environmentId, tracker] of this.trackers) {
      if (active) {
        this.open(tracker, now);
      } else {
        this.close(environmentId, tracker, now);
        tracker.answered = false;
        tracker.droppedAt = null;
      }
    }
  }

  setNetworkKind(kind: NetworkReportNetworkKind) {
    if (kind === this.networkKind) return;
    this.networkKind = kind;
    const now = this.options.now();
    for (const [environmentId, tracker] of this.trackers) {
      if (tracker.window === null) continue;
      this.close(environmentId, tracker, now);
      this.open(tracker, now);
    }
  }

  connectionState(environmentId: EnvironmentId, state: SupervisorConnectionState) {
    const now = this.options.now();
    const tracker = this.tracker(environmentId, state);
    const window = tracker.window;
    window?.addPhaseTime(tracker.phase, now);
    const failed = state.lastFailure !== null && state.lastFailure !== tracker.lastFailure;
    if (state.lastFailure !== null) tracker.lastFailure = state.lastFailure;
    if (failed) tracker.sessionFailed = true;
    if (failed && window !== null && state.lastFailure !== null) {
      if (tracker.phase !== "connected") {
        window.failedAttempts += 1;
        if (state.lastFailure.reason === "timeout") window.setupTimeouts += 1;
      } else if (tracker.answered) {
        window.drops[dropCause(state.lastFailure, tracker.heartbeatTimedOut)] += 1;
        tracker.droppedAt = now;
      } else {
        window.awaitingConnection = true;
      }
    }
    tracker.phase = state.phase;
    tracker.desired = state.desired;
    if (state.phase === "connected") {
      if (tracker.droppedAt !== null) {
        window?.recoveries.push(now - tracker.droppedAt);
        tracker.droppedAt = null;
      }
      if (window !== null && window.awaitingConnection) {
        window.initialConnectMs ??= now - window.startedAt;
        window.awaitingConnection = false;
      }
    }
    if (!state.desired) {
      this.close(environmentId, tracker, now);
      tracker.droppedAt = null;
    } else {
      this.open(tracker, now);
      this.rollOver(environmentId, tracker, now);
    }
  }

  /** Forgets an environment without reporting its open window. */
  removeEnvironment(environmentId: EnvironmentId) {
    this.trackers.delete(environmentId);
  }

  /** Closes windows that reached their maximum length. */
  tick() {
    const now = this.options.now();
    for (const [environmentId, tracker] of this.trackers) {
      this.rollOver(environmentId, tracker, now);
    }
  }

  meter(
    environmentId: EnvironmentId,
    routeKind: ConnectionRouteKind,
    routeId: string,
  ): SocketMeter {
    const current = () => this.trackers.get(environmentId)?.window ?? null;
    // Send times of unanswered pings, oldest first.
    const pings: Array<number> = [];
    return {
      attach: (socket) => {
        const send = socket.send.bind(socket);
        socket.send = (data) => {
          const window = current();
          if (window !== null) {
            window.bytesSent += payloadSize(data);
            window.messagesSent += 1;
          }
          if (data === PING_FRAME) {
            pings.push(this.options.now());
            if (window !== null) window.heartbeats += 1;
          }
          send(data);
        };
        socket.addEventListener("message", (event) => {
          const now = this.options.now();
          const window = current();
          const data = event.data;
          if (window !== null) {
            window.received(payloadSize(data), now);
            const tracker = this.trackers.get(environmentId);
            if (tracker !== undefined) tracker.answered = true;
          }
          if (data === PONG_FRAME) {
            const sentAt = pings.shift();
            if (window !== null) {
              window.heartbeatReplies += 1;
              if (sentAt !== undefined) window.rtts.push(now - sentAt);
            }
          }
        });
      },
      opened: () => {
        const tracker = this.trackers.get(environmentId);
        if (tracker === undefined) return;
        tracker.answered = false;
        tracker.heartbeatTimedOut = false;
        tracker.routeKind = routeKind;
        if (tracker.window !== null) {
          if (tracker.window.routeKind === null) {
            tracker.window.routeKind = routeKind;
          } else if (tracker.window.routeKind !== routeKind) {
            const now = this.options.now();
            this.close(environmentId, tracker, now);
            this.open(tracker, now);
          }
        }
        const previous = tracker.routeId;
        if (previous !== null && previous !== routeId) {
          if (!tracker.sessionFailed) {
            if (tracker.window !== null) tracker.window.routeSwitches += 1;
            tracker.switchedFrom = previous;
          } else if (tracker.switchedFrom === routeId) {
            if (tracker.window !== null) tracker.window.routeSwitchBacks += 1;
            tracker.switchedFrom = null;
          }
        }
        tracker.routeId = routeId;
        tracker.sessionFailed = false;
      },
      heartbeatTimedOut: () => {
        const tracker = this.trackers.get(environmentId);
        if (tracker !== undefined) tracker.heartbeatTimedOut = true;
      },
    };
  }

  private tracker(
    environmentId: EnvironmentId,
    state: SupervisorConnectionState,
  ): EnvironmentTracker {
    const existing = this.trackers.get(environmentId);
    if (existing !== undefined) return existing;
    const created: EnvironmentTracker = {
      phase: state.phase,
      desired: state.desired,
      lastFailure: state.lastFailure,
      answered: false,
      heartbeatTimedOut: false,
      routeId: null,
      sessionFailed: false,
      switchedFrom: null,
      routeKind: null,
      droppedAt: null,
      window: null,
    };
    this.trackers.set(environmentId, created);
    return created;
  }

  private open(tracker: EnvironmentTracker, now: number) {
    if (tracker.window !== null || !this.active || !tracker.desired) return;
    tracker.window = new ReportWindow(
      now,
      this.networkKind,
      tracker.routeKind,
      tracker.phase !== "connected",
    );
  }

  private close(environmentId: EnvironmentId, tracker: EnvironmentTracker, now: number) {
    const window = tracker.window;
    if (window === null) return;
    tracker.window = null;
    window.addPhaseTime(tracker.phase, now);
    if (!window.isWorthReporting(now)) return;
    this.options.report({
      environmentId,
      startedAt: window.startedAt,
      endedAt: now,
      metrics: window.metrics(now),
    });
  }

  private rollOver(environmentId: EnvironmentId, tracker: EnvironmentTracker, now: number) {
    const window = tracker.window;
    if (window === null || now - window.startedAt < NETWORK_REPORT_WINDOW_MS) return;
    this.close(environmentId, tracker, now);
    this.open(tracker, now);
  }
}
