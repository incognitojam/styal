import {
  AuthDeviceOperateScope,
  DeviceError,
  DevicePeerCommand,
  LOCAL_DEVICE_HOST_ID,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { whileStreaming } from "./DeviceIdle.ts";
import * as DeviceSharing from "./DeviceSharing.ts";
import {
  isAllowedDeviceHubRequest,
  proxyDeviceHttp,
  proxyDeviceWebSocket,
} from "./DeviceHubProxy.ts";

const isDeviceError = Schema.is(DeviceError);
const encodeDeviceError = Schema.encodeSync(DeviceError);
const AgentRpcRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optional(Schema.Unknown),
  method: Schema.String,
  params: Schema.Record(Schema.String, Schema.Unknown),
});

const authenticate = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* auth.authenticateHttpRequest(request);
  if (
    !session.scopes.includes(AuthDeviceOperateScope) ||
    !session.subject.startsWith("device-host:")
  )
    return yield* Effect.fail(HttpServerResponse.empty({ status: 403 }));
  return session;
});
/**
 * Device failures travel as encoded `DeviceError`s so the source can show the real
 * cause. Other failures are request or credential problems.
 */
const errors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.succeed(
        HttpServerResponse.isHttpServerResponse(error)
          ? error
          : isDeviceError(error)
            ? HttpServerResponse.jsonUnsafe(
                { error: encodeDeviceError(error) },
                { status: 422, headers: { "cache-control": "no-store" } },
              )
            : HttpServerResponse.text(
                "Device sharing is unavailable. Check device access and reconnect the environment.",
                { status: EnvironmentAuth.isServerAuthCredentialError(error) ? 401 : 400 },
              ),
      ),
    ),
  );

const command = errors(
  Effect.gen(function* () {
    const session = yield* authenticate;
    const input = yield* HttpServerRequest.schemaBodyJson(DevicePeerCommand);
    const sharing = yield* DeviceSharing.DeviceSharing;
    return yield* HttpServerResponse.json(yield* sharing.command(session, input), {
      headers: { "cache-control": "no-store" },
    });
  }),
);

/**
 * Routes agent-device's own remote proxy forwards, except direct uploads. Their
 * preflight response carries the daemon's credential and loopback address, which
 * agent-device's proxy rewrites; without it the client falls back to `POST /upload`.
 * Daemon administration routes such as human-control holds stay local.
 */
const isAllowedAgentRequest = (path: string, method: string) =>
  path === "/rpc" || path === "/upload"
    ? method === "POST"
    : path === "/health" ||
        path === "/artifacts" ||
        path.startsWith("/artifacts/") ||
        /^\/sessions\/[^/]+\/requests\/[^/]+\/diagnostics$/.test(path)
      ? method === "GET"
      : false;
const AGENT_ACCESS_ENDED =
  "Agent device access to this environment ended. Open the device again with device_open to renew it.";
/** agent-device reads `/rpc` failures as JSON-RPC errors, as its own remote proxy sends them. */
const agentAccessEnded = (path: string) =>
  path === "/rpc"
    ? HttpServerResponse.jsonUnsafe(
        { jsonrpc: "2.0", id: null, error: { code: -32001, message: AGENT_ACCESS_ENDED } },
        { status: 401 },
      )
    : HttpServerResponse.text(AGENT_ACCESS_ENDED, { status: 401 });
const agentToken = (request: HttpServerRequest.HttpServerRequest) => {
  const authorization = request.headers.authorization ?? "";
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice("bearer ".length)
    : (request.headers["x-agent-device-token"] ?? "");
};

const proxy = errors(
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.empty({ status: 400 });
    const agent = url.value.pathname.startsWith("/api/device-share/agent/");
    const prefix = agent ? "/api/device-share/agent" : "/api/device-share/hub";
    const path = url.value.pathname.slice(prefix.length);
    const upgrade = request.headers.upgrade?.toLowerCase() === "websocket";
    const sharing = yield* DeviceSharing.DeviceSharing;
    let target: { origin: string; headers?: Readonly<Record<string, string>> };
    if (agent) {
      // Agents hold a separate credential that reaches only this proxy, never peer commands.
      const token = agentToken(request);
      const resolved = token ? yield* sharing.agentTarget(token) : null;
      if (!resolved) return agentAccessEnded(path);
      if (upgrade || !isAllowedAgentRequest(path, request.method))
        return HttpServerResponse.empty({ status: 404 });
      target = resolved;
      // Counts until the request scope closes, so a long agent request counts until it ends.
      // Hub requests are a person viewing or driving the device, which a restart can resume.
      yield* sharing.beginUse(resolved.sourceId);
    } else {
      yield* authenticate;
      if (!isAllowedDeviceHubRequest(path, request.method, upgrade))
        return HttpServerResponse.empty({ status: 404 });
      target = yield* sharing.hubTarget;
    }
    url.value.searchParams.delete("hostId");
    url.value.searchParams.delete("wsTicket");
    const query = url.value.searchParams.toString();
    const upstream = `${target.origin}${path}${query ? `?${query}` : ""}`;
    let jsonBody: typeof AgentRpcRequest.Type | undefined;
    if (agent && path === "/rpc" && request.method === "POST") {
      const body = yield* HttpServerRequest.schemaBodyJson(AgentRpcRequest);
      const params = { ...body.params };
      // agent-device prefers params.token to header credentials. The agent credential
      // authenticates this route; only the local daemon token may go upstream.
      delete params.token;
      jsonBody = { ...body, params };
    }
    return yield* upgrade
      ? proxyDeviceWebSocket(request, upstream.replace(/^http/, "ws")).pipe(
          whileStreaming(LOCAL_DEVICE_HOST_ID, path, url.value.searchParams),
        )
      : proxyDeviceHttp(request, upstream, {}, target.headers, jsonBody);
  }),
);

export const deviceSharingRouteLayer = HttpRouter.add("POST", "/api/device-share/command", command);
export const deviceSharingProxyRouteLayer = HttpRouter.add("*", "/api/device-share/hub/*", proxy);
export const deviceSharingAgentRouteLayer = HttpRouter.add("*", "/api/device-share/agent/*", proxy);
