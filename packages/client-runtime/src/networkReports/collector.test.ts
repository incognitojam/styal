import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import type * as Socket from "effect/socket/Socket";

import {
  type ConnectionAttemptError,
  ConnectionTransientError,
  type ConnectionTransientReason,
  type SupervisorConnectionPhase,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import {
  NETWORK_REPORT_WINDOW_MS,
  NetworkReportCollector,
  type NetworkReportRecord,
} from "./collector.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PING = '{"_tag":"Ping"}';
const PONG = '{"_tag":"Pong"}';

function harness() {
  let now = 1_000_000;
  const reports: Array<NetworkReportRecord> = [];
  const collector = new NetworkReportCollector({
    now: () => now,
    report: (record) => reports.push(record),
  });
  const advance = (ms: number) => {
    now += ms;
  };
  const state = (
    phase: SupervisorConnectionPhase,
    lastFailure: ConnectionAttemptError | null = null,
    desired = true,
  ) =>
    collector.connectionState(ENVIRONMENT_ID, {
      desired,
      network: "online",
      phase,
      stage: null,
      attempt: 1,
      generation: 1,
      lastFailure,
      retryAt: null,
    } satisfies SupervisorConnectionState);
  return { collector, reports, advance, state };
}

function fakeSocket() {
  const listeners: Array<(event: Socket.WebSocketEvent) => void> = [];
  const socket: Socket.WebSocketLike = {
    readyState: 1,
    addEventListener: (type, listener) => {
      if (type === "message") listeners.push(listener);
    },
    removeEventListener: () => undefined,
    close: () => undefined,
    send: () => undefined,
  };
  return {
    socket,
    receive: (data: string) => {
      for (const listener of listeners) listener({ type: "message", data });
    },
  };
}

function failure(detail: string, reason: ConnectionTransientReason = "transport") {
  return new ConnectionTransientError({ reason, detail });
}

const NO_FAILURES = {
  drops: 0,
  dropsStoppedResponding: 0,
  dropsDisconnected: 0,
  dropsProbeFailed: 0,
  dropsOther: 0,
  failedAttempts: 0,
  setupTimeouts: 0,
  routeSwitches: 0,
  routeSwitchBacks: 0,
};

describe("NetworkReportCollector", () => {
  it("summarizes a connection that drops in a dead zone and recovers", () => {
    const { collector, reports, advance, state } = harness();
    collector.setNetworkKind("cellular");
    state("connecting");
    const meter = collector.meter(ENVIRONMENT_ID, "relay", "relay");
    const { socket, receive } = fakeSocket();
    meter.attach(socket);
    advance(800);
    meter.opened();
    state("connected");

    // Two heartbeats; the second reply comes back slowly.
    advance(5_000);
    socket.send(PING);
    advance(120);
    receive(PONG);
    advance(5_000);
    socket.send(PING);
    advance(900);
    receive(PONG);

    // Signal lost: the heartbeat stops answering and the session drops.
    advance(10_000);
    meter.heartbeatTimedOut();
    const dropped = failure("stopped responding");
    state("backoff", dropped);
    advance(2_000);
    state("connecting", dropped);
    advance(3_000);
    state("backoff", failure("timed out"));
    collector.setNetworkKind("none");
    advance(20_000);
    collector.setNetworkKind("cellular");
    advance(1_500);
    state("connected");
    advance(10_000);
    collector.setActive(false);

    expect(reports.map((report) => report.metrics)).toEqual([
      {
        durationMs: 26_820,
        networkKind: "cellular",
        routeKind: "relay",
        connectedMs: 21_020,
        connectingMs: 5_800,
        offlineMs: 0,
        initialConnectMs: 800,
        ...NO_FAILURES,
        drops: 1,
        dropsStoppedResponding: 1,
        failedAttempts: 1,
        recoveries: 0,
        recoveryMs: [],
        heartbeats: 2,
        heartbeatReplies: 2,
        rttP50Ms: 120,
        rttP90Ms: 900,
        rttMaxMs: 900,
        bytesReceived: PONG.length * 2,
        bytesSent: PING.length * 2,
        messagesReceived: 2,
        messagesSent: 2,
        peakReceiveBytesPerSecond: PONG.length,
      },
      {
        durationMs: 20_000,
        networkKind: "none",
        routeKind: "relay",
        connectedMs: 0,
        connectingMs: 20_000,
        offlineMs: 0,
        ...NO_FAILURES,
        recoveries: 0,
        recoveryMs: [],
        heartbeats: 0,
        heartbeatReplies: 0,
        bytesReceived: 0,
        bytesSent: 0,
        messagesReceived: 0,
        messagesSent: 0,
        peakReceiveBytesPerSecond: 0,
      },
      {
        durationMs: 11_500,
        networkKind: "cellular",
        routeKind: "relay",
        connectedMs: 10_000,
        connectingMs: 1_500,
        offlineMs: 0,
        initialConnectMs: 1_500,
        ...NO_FAILURES,
        // Measured from the drop, across the dead zone.
        recoveries: 1,
        recoveryMs: [26_500],
        heartbeats: 0,
        heartbeatReplies: 0,
        bytesReceived: 0,
        bytesSent: 0,
        messagesReceived: 0,
        messagesSent: 0,
        peakReceiveBytesPerSecond: 0,
      },
    ]);
  });

  it("does not count a failure the supervisor keeps reporting as a new one", () => {
    const { collector, reports, advance, state } = harness();
    const earlier = failure("earlier");
    state("backoff", earlier);
    advance(1_000);
    state("connected");
    advance(10_000);
    // A replaced session (a better route, a long resume) restarts with the
    // last failure still attached.
    state("connecting", earlier);
    advance(500);
    state("connected");
    advance(10_000);
    collector.setActive(false);

    expect(reports).toHaveLength(1);
    expect(reports[0]!.metrics).toMatchObject({ drops: 0, failedAttempts: 0, recoveries: 0 });
  });

  it("counts a session that died in the background as a reconnect, not a drop", () => {
    const { collector, reports, advance, state } = harness();
    state("connected");
    const meter = collector.meter(ENVIRONMENT_ID, "relay", "relay");
    const { socket, receive } = fakeSocket();
    meter.attach(socket);
    meter.opened();
    receive(PONG);
    advance(10_000);
    collector.setActive(false);
    advance(60_000);
    collector.setActive(true);
    // The socket closed while the app was away; the close arrives on return.
    advance(300);
    state("backoff", failure("disconnected"));
    advance(1_200);
    state("connected");
    receive(PONG);
    advance(10_000);
    // A failure after the new session answered is a drop.
    state("backoff", failure("stopped responding"));
    advance(2_000);
    state("connected");
    advance(5_000);
    collector.setActive(false);

    expect(reports.map(({ metrics }) => metrics)).toEqual([
      expect.objectContaining({ durationMs: 10_000, drops: 0 }),
      expect.objectContaining({
        durationMs: 18_500,
        initialConnectMs: 1_500,
        drops: 1,
        recoveries: 1,
        recoveryMs: [2_000],
      }),
    ]);
  });

  it("records why each live session dropped and which attempts timed out", () => {
    const { collector, reports, advance, state } = harness();
    const meter = collector.meter(ENVIRONMENT_ID, "relay", "relay");
    const { socket, receive } = fakeSocket();
    meter.attach(socket);
    const connect = () => {
      meter.opened();
      state("connected");
      receive(PONG);
      advance(5_000);
    };
    state("connecting");
    connect();
    // Heartbeats went unanswered, so the client closed the socket.
    meter.heartbeatTimedOut();
    state("backoff", failure("stopped responding"));
    connect();
    state("backoff", failure("disconnected"));
    connect();
    state("connecting", failure("did not respond to a connection health check", "timeout"));
    state("backoff", failure("did not respond during connection setup", "timeout"));
    state("backoff", failure("relay unavailable", "relay-unavailable"));
    connect();
    collector.setActive(false);

    expect(reports[0]!.metrics).toMatchObject({
      ...NO_FAILURES,
      drops: 3,
      dropsStoppedResponding: 1,
      dropsDisconnected: 1,
      dropsProbeFailed: 1,
      failedAttempts: 2,
      setupTimeouts: 1,
    });
  });

  it("counts a switch to a better route and the switch back after it fails", () => {
    const { collector, reports, advance, state } = harness();
    collector.setNetworkKind("wifi");
    const relay = collector.meter(ENVIRONMENT_ID, "relay", "relay");
    const lan = collector.meter(ENVIRONMENT_ID, "lan", "connection-lan");
    const relaySocket = fakeSocket();
    const lanSocket = fakeSocket();
    relay.attach(relaySocket.socket);
    lan.attach(lanSocket.socket);
    state("connecting");
    relay.opened();
    state("connected");
    relaySocket.receive(PONG);
    advance(60_000);
    // A better route answered, so the session is replaced without a failure.
    state("connecting");
    lan.opened();
    state("connected");
    lanSocket.receive(PONG);
    advance(20_000);
    state("backoff", failure("disconnected"));
    advance(1_000);
    state("connecting", failure("disconnected"));
    relay.opened();
    state("connected");
    advance(30_000);
    collector.setActive(false);

    expect(
      reports.map(({ metrics }) => [
        metrics.routeKind,
        metrics.routeSwitches,
        metrics.routeSwitchBacks,
        metrics.drops,
      ]),
    ).toEqual([
      ["relay", 0, 0, 0],
      ["lan", 1, 0, 1],
      ["relay", 0, 1, 0],
    ]);
  });

  it("starts a new window when the route changes or the window reaches its limit", () => {
    const { collector, reports, advance, state } = harness();
    collector.setNetworkKind("wifi");
    state("connected");
    collector.meter(ENVIRONMENT_ID, "lan", "lan").opened();
    advance(30_000);
    collector.meter(ENVIRONMENT_ID, "relay", "relay").opened();
    advance(NETWORK_REPORT_WINDOW_MS);
    collector.tick();
    advance(30_000);
    collector.setActive(false);

    expect(
      reports.map(({ metrics }) => [metrics.routeKind, metrics.durationMs, metrics.connectedMs]),
    ).toEqual([
      ["lan", 30_000, 30_000],
      ["relay", NETWORK_REPORT_WINDOW_MS, NETWORK_REPORT_WINDOW_MS],
      ["relay", 30_000, 30_000],
    ]);
  });

  it("skips connections to the same device, short windows and background time", () => {
    const { collector, reports, advance, state } = harness();
    state("connected");
    collector.meter(ENVIRONMENT_ID, "loopback", "loopback").opened();
    advance(60_000);
    collector.setNetworkKind("wifi");
    collector.meter(ENVIRONMENT_ID, "tailnet", "tailnet").opened();
    advance(2_000);
    collector.setActive(false);
    advance(60_000);
    // Traffic while in the background belongs to no window.
    collector.setActive(true);
    advance(6_000);
    state("available", null, false);

    expect(reports.map(({ metrics }) => [metrics.routeKind, metrics.durationMs])).toEqual([
      ["tailnet", 6_000],
    ]);
  });

  it("matches heartbeat replies to pings in order and finds the busiest second", () => {
    const { collector, reports, advance, state } = harness();
    state("connected");
    const meter = collector.meter(ENVIRONMENT_ID, "public", "public");
    const { socket, receive } = fakeSocket();
    meter.attach(socket);
    meter.opened();
    socket.send(PING);
    advance(5_000);
    // The first reply is late, so a second ping goes out before it arrives.
    socket.send(PING);
    advance(1_000);
    receive(PONG);
    advance(100);
    receive(PONG);
    advance(1_000);
    receive("x".repeat(300));
    receive("x".repeat(200));
    advance(1_000);
    receive("x".repeat(400));
    advance(3_000);
    collector.setActive(false);

    expect(reports[0]!.metrics).toMatchObject({
      heartbeats: 2,
      heartbeatReplies: 2,
      rttP50Ms: 1_100,
      rttMaxMs: 6_000,
      messagesReceived: 5,
      bytesReceived: PONG.length * 2 + 900,
      peakReceiveBytesPerSecond: 500,
    });
  });
});
