import type { ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import type {
  ConnectionRouteFailure,
  ConnectionTarget,
  SupervisorConnectionState,
} from "./model.ts";
import {
  RELAY_ROUTE_ID,
  connectionRouteId,
  connectionRoutes,
  routeHttpBaseUrl,
  usableRoutes,
} from "./routes.ts";

export type EnvironmentConnectionPhase =
  | "available"
  | "offline"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error"
  | "unsupported";

export interface EnvironmentConnectionPresentation {
  readonly phase: EnvironmentConnectionPhase;
  readonly error: string | null;
  readonly traceId: string | null;
  /** The last attempt failed on every saved route, and there is more than one. */
  readonly unreachable?: boolean;
  readonly routeFailures?: ReadonlyArray<ConnectionRouteFailure>;
}

export interface EnvironmentPresentation {
  readonly entry: ConnectionCatalogEntry;
  readonly connection: EnvironmentConnectionPresentation;
  readonly serverConfig: ServerConfig | null;
}

export function presentConnectionState(
  state: SupervisorConnectionState,
): EnvironmentConnectionPresentation {
  switch (state.phase) {
    case "available":
      return { phase: "available", error: null, traceId: null };
    case "offline":
      return { phase: "offline", error: null, traceId: null };
    case "connecting":
      return {
        phase: state.attempt <= 1 && state.lastFailure === null ? "connecting" : "reconnecting",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
    case "connected":
      return { phase: "connected", error: null, traceId: null };
    case "backoff":
      return {
        phase: "reconnecting",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
    case "blocked":
      return {
        phase: state.lastFailure?.reason === "unsupported" ? "unsupported" : "error",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
  }
}

export function connectionStatusText(connection: EnvironmentConnectionPresentation): string {
  switch (connection.phase) {
    case "available":
      return "Available";
    case "offline":
      return "Offline";
    case "connecting":
      return "Connecting...";
    case "reconnecting":
      if (connection.unreachable) return "Unreachable on every route. Reconnecting...";
      return connection.error
        ? `Failed to connect. Reconnecting... Reason: ${connection.error}`
        : "Reconnecting...";
    case "connected":
      return "Connected";
    case "unsupported":
      return "Client not supported";
    case "error":
      if (connection.unreachable) return "Unreachable on every route";
      return connection.error
        ? `Connection failed. Reason: ${connection.error}`
        : "Connection failed";
  }
}

export function connectionStatusTitle(connection: EnvironmentConnectionPresentation): string {
  if (connection.unreachable) return "Unreachable on every route";
  if (connection.phase === "reconnecting" && connection.error) {
    return "Failed to connect. Reconnecting...";
  }
  return connectionStatusText({ ...connection, error: null });
}

export function presentEnvironmentConnection(
  state: SupervisorConnectionState,
  entry: ConnectionCatalogEntry,
): EnvironmentConnectionPresentation {
  const connection = presentConnectionState(state);
  if (state.routeFailures.length === 0) return connection;
  const failed = new Set(state.routeFailures.map((failure) => failure.routeId));
  const routes = usableRoutes(entry);
  const unreachable =
    (connection.phase === "reconnecting" || connection.phase === "error") &&
    state.lastFailure !== null &&
    routes.length > 1 &&
    routes.every((route) => failed.has(connectionRouteId(route.target)));
  return { ...connection, unreachable, routeFailures: state.routeFailures };
}

/** A few words for a route row; `routeFailureDetail` has the full reason. */
export function routeFailureLabel(failure: ConnectionRouteFailure): string {
  if (failure._tag === "NoAnswer") return "No answer";
  switch (failure.error.reason) {
    case "network":
      return "Couldn't connect";
    case "timeout":
      return "Timed out";
    case "transport":
      return "Connection dropped";
    case "endpoint-unavailable":
      return failure.routeId === RELAY_ROUTE_ID
        ? "styal Link can't reach the computer"
        : "Not reachable";
    case "relay-unavailable":
      return "styal Link unavailable";
    case "remote-unavailable":
      return "Server error";
    case "authentication":
      return "Sign-in rejected";
    case "permission":
      return "Not permitted";
    case "configuration":
      return "Route misconfigured";
    case "unsupported":
      return "Not supported";
  }
}

export function routeFailureDetail(failure: ConnectionRouteFailure): string {
  return failure._tag === "NoAnswer"
    ? "Did not answer the reachability check."
    : failure.error.message;
}

/**
 * SSH connections ride a local forward that disappears with the client, so they have no stable
 * address.
 */
export function environmentMcpUrl(input: {
  readonly entry: ConnectionCatalogEntry;
  readonly relayHttpBaseUrl?: string | undefined;
  readonly connectedTarget?: ConnectionTarget | null | undefined;
}): string | null {
  const connectedRouteId = input.connectedTarget ? connectionRouteId(input.connectedTarget) : null;
  const routes = connectionRoutes(input.entry);
  const connectedRoute = routes.find(
    (route) => connectionRouteId(route.target) === connectedRouteId,
  );
  for (const route of connectedRoute ? [connectedRoute, ...routes] : routes) {
    const httpBaseUrl =
      route.target._tag === "RelayConnectionTarget"
        ? (input.relayHttpBaseUrl ?? null)
        : routeHttpBaseUrl(route);
    const mcpUrl = httpBaseUrl === null ? null : mcpUrlFromBase(httpBaseUrl);
    if (mcpUrl !== null) return mcpUrl;
  }
  return null;
}

function mcpUrlFromBase(httpBaseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(httpBaseUrl);
  } catch {
    return null;
  }
  url.pathname = "/mcp";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function connectionCatalogDisplayUrl(entry: ConnectionCatalogEntry): string | null {
  switch (entry.target._tag) {
    case "PrimaryConnectionTarget":
      return entry.target.httpBaseUrl;
    case "RelayConnectionTarget":
      return null;
    case "BearerConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "BearerConnectionProfile"
        ? entry.profile.value.httpBaseUrl
        : null;
    case "SshConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "SshConnectionProfile"
        ? `${entry.profile.value.target.username}@${entry.profile.value.target.hostname}`
        : null;
  }
}
