/**
 * The proxy token is the only credential: it is random, belongs to one lease, and stops working
 * when the lease ends. Calls get the same tier checks as `hardware_call`.
 */
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { HARDWARE_PROXY_PATH_PREFIX, HardwareService } from "./HardwareService.ts";

const TOKEN_PATTERN = /^[0-9a-f]{48}$/;

const proxy = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const hardware = yield* HardwareService;
  const url = new URL(request.url, "http://hardware.invalid");
  const rest = url.pathname.slice(HARDWARE_PROXY_PATH_PREFIX.length + 1);
  const slash = rest.indexOf("/");
  const token = slash === -1 ? rest : rest.slice(0, slash);
  if (!TOKEN_PATTERN.test(token)) return HttpServerResponse.text("Not Found", { status: 404 });
  const response = yield* hardware.proxy({
    token,
    method: request.method,
    path: slash === -1 ? "/" : rest.slice(slash),
    query: [...url.searchParams.entries()],
  });
  const headers = {
    "cache-control": "no-store",
    ...(response.contentType === null ? {} : { "content-type": response.contentType }),
  };
  return typeof response.body === "string"
    ? HttpServerResponse.text(response.body, { status: response.status, headers })
    : HttpServerResponse.uint8Array(response.body, { status: response.status, headers });
});

export const proxyRouteLayer = HttpRouter.add("*", `${HARDWARE_PROXY_PATH_PREFIX}/*`, proxy);
