import {
  AuthDeviceOperateScope,
  DeviceOperationError,
  DevicePeerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as DeviceSharing from "./DeviceSharing.ts";
import {
  isAllowedDeviceHubRequest,
  proxyDeviceHttp,
  proxyDeviceWebSocket,
} from "./DeviceHubProxy.ts";

const isDeviceOperationError = Schema.is(DeviceOperationError);
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
const errors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.succeed(
        HttpServerResponse.isHttpServerResponse(error)
          ? error
          : HttpServerResponse.text(
              "Device sharing is unavailable. Check device access and reconnect the environment.",
              {
                status: EnvironmentAuth.isServerAuthCredentialError(error)
                  ? 401
                  : isDeviceOperationError(error)
                    ? error.reason === "hub_rejected"
                      ? 403
                      : error.reason === "invalid_payload"
                        ? 400
                        : 503
                    : 400,
              },
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

const proxy = errors(
  Effect.gen(function* () {
    yield* authenticate;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.empty({ status: 400 });
    const agent = url.value.pathname.startsWith("/api/device-share/agent/");
    const prefix = agent ? "/api/device-share/agent" : "/api/device-share/hub";
    const path = url.value.pathname.slice(prefix.length);
    const upgrade = request.headers.upgrade?.toLowerCase() === "websocket";
    if (
      agent
        ? upgrade || /shutdown|stop-daemon/.test(path)
        : !isAllowedDeviceHubRequest(path, request.method, upgrade)
    )
      return HttpServerResponse.empty({ status: 404 });
    const sharing = yield* DeviceSharing.DeviceSharing;
    const { origin, headers } = yield* sharing.proxyTarget(agent);
    url.value.searchParams.delete("hostId");
    url.value.searchParams.delete("wsTicket");
    const query = url.value.searchParams.toString();
    const upstream = `${origin}${path}${query ? `?${query}` : ""}`;
    let jsonBody: typeof AgentRpcRequest.Type | undefined;
    if (agent && path === "/rpc" && request.method === "POST") {
      const body = yield* HttpServerRequest.schemaBodyJson(AgentRpcRequest);
      const params = { ...body.params };
      // agent-device prefers params.token to header credentials. The peer token
      // authenticates this route; only the local daemon token may go upstream.
      delete params.token;
      jsonBody = { ...body, params };
    }
    return yield* upgrade
      ? proxyDeviceWebSocket(request, upstream.replace(/^http/, "ws"))
      : proxyDeviceHttp(request, upstream, origin, headers, jsonBody);
  }),
);

export const deviceSharingRouteLayer = HttpRouter.add("POST", "/api/device-share/command", command);
export const deviceSharingProxyRouteLayer = HttpRouter.add("*", "/api/device-share/hub/*", proxy);
export const deviceSharingAgentRouteLayer = HttpRouter.add("*", "/api/device-share/agent/*", proxy);
