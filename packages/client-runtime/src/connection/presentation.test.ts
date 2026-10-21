import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  RelayConnectionTarget,
  type SupervisorConnectionState,
} from "./model.ts";
import {
  environmentMcpUrl,
  connectionStatusText,
  presentEnvironmentConnection,
  presentConnectionState,
  routeFailureLabel,
} from "./presentation.ts";

const TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
  connectionId: "connection-1",
});

const ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: TARGET.connectionId,
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    }),
  ),
  enabled: true,
};

function supervisorState(overrides: Partial<SupervisorConnectionState>): SupervisorConnectionState {
  return {
    desired: true,
    network: "online",
    phase: "connecting",
    stage: "preparing",
    attempt: 1,
    generation: 0,
    lastFailure: null,
    retryAt: null,
    routeFailures: [],
    ...overrides,
  };
}

describe("connection presentation", () => {
  it("copies the MCP address of the route this device is connected over", () => {
    const route = (connectionId: string, httpBaseUrl: string): ConnectionRoute => {
      const target = new BearerConnectionTarget({ ...TARGET, connectionId });
      return {
        target,
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId,
            environmentId: TARGET.environmentId,
            label: TARGET.label,
            httpBaseUrl,
            wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
          }),
        ),
      };
    };
    const lan = route("lan", "http://192.168.4.53:3773/");
    const tailnet = route("tailnet", "http://100.115.1.44:3773/");
    const serve = route("serve", "https://machine.tailnet.ts.net/");
    const entry: ConnectionCatalogEntry = {
      ...ENTRY,
      target: lan.target,
      profile: lan.profile,
      alternateRoutes: [tailnet, serve],
    };

    expect(environmentMcpUrl({ entry, connectedTarget: tailnet.target })).toBe(
      "http://100.115.1.44:3773/mcp",
    );
    expect(environmentMcpUrl({ entry })).toBe("http://192.168.4.53:3773/mcp");
  });

  it("passes over routes without an address of their own", () => {
    const relay = new RelayConnectionTarget({
      environmentId: TARGET.environmentId,
      label: TARGET.label,
    });
    const entry: ConnectionCatalogEntry = {
      ...ENTRY,
      target: relay,
      profile: Option.none(),
      alternateRoutes: [{ target: ENTRY.target, profile: ENTRY.profile }],
    };

    expect(environmentMcpUrl({ entry, connectedTarget: relay })).toBe(
      "https://environment.example.test/mcp",
    );
    expect(
      environmentMcpUrl({
        entry,
        connectedTarget: relay,
        relayHttpBaseUrl: "https://tunnel.example.test",
      }),
    ).toBe("https://tunnel.example.test/mcp");
  });

  it("distinguishes initial connection, reconnect, and retry errors", () => {
    expect(presentConnectionState(supervisorState({ phase: "connecting", attempt: 1 }))).toEqual({
      phase: "connecting",
      error: null,
      traceId: null,
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "connecting",
          attempt: 2,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Socket closed.",
            traceId: "trace-previous",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Socket closed.",
      traceId: "trace-previous",
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "backoff",
          attempt: 2,
          retryAt: 1,
          routeFailures: [],
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Disconnected.",
            traceId: "trace-1",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Disconnected.",
      traceId: "trace-1",
    });
  });

  describe("unreachable on every route", () => {
    const relayFailure = new ConnectionTransientError({
      reason: "endpoint-unavailable",
      detail: "Relay could not reach the environment endpoint (endpoint_request_failed).",
    });
    const lanThenRelay: ConnectionCatalogEntry = {
      ...ENTRY,
      alternateRoutes: [
        {
          target: new RelayConnectionTarget({
            environmentId: TARGET.environmentId,
            label: TARGET.label,
          }),
          profile: Option.none(),
        },
      ],
    };
    const failing = (routeFailures: SupervisorConnectionState["routeFailures"]) =>
      supervisorState({
        phase: "backoff",
        stage: null,
        lastFailure: relayFailure,
        retryAt: 1_000,
        routeFailures,
      });

    it("names no single route when every route failed", () => {
      const connection = presentEnvironmentConnection(
        failing([
          { _tag: "NoAnswer", routeId: TARGET.connectionId },
          { _tag: "Failed", routeId: "relay", error: relayFailure },
        ]),
        lanThenRelay,
      );
      expect(connection.unreachable).toBe(true);
      expect(connectionStatusText(connection)).toBe("Unreachable on every route. Reconnecting...");
      expect(connection.routeFailures?.map(routeFailureLabel)).toEqual([
        "No answer",
        "styal Link can't reach the computer",
      ]);
    });

    it("keeps the single reason when a route was not heard from", () => {
      const connection = presentEnvironmentConnection(
        failing([{ _tag: "Failed", routeId: "relay", error: relayFailure }]),
        lanThenRelay,
      );
      expect(connection.unreachable).toBe(false);
      expect(connectionStatusText(connection)).toBe(
        `Failed to connect. Reconnecting... Reason: ${relayFailure.detail}`,
      );
    });

    it("keeps the single reason for an environment with one route", () => {
      const connection = presentEnvironmentConnection(
        failing([{ _tag: "Failed", routeId: TARGET.connectionId, error: relayFailure }]),
        ENTRY,
      );
      expect(connection.unreachable).toBe(false);
    });
  });

  it("preserves an explicitly available environment while offline", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          desired: false,
          network: "offline",
          phase: "available",
          stage: null,
          attempt: 0,
        }),
        ENTRY,
      ),
    ).toEqual({
      phase: "available",
      error: null,
      traceId: null,
    });
  });
});
