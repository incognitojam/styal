import Mime from "@effect/platform-node/Mime";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { isDevProxiedPath } from "@t3tools/shared/devProxy";
import { decodeOtlpTraceRecords } from "@t3tools/shared/observability";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { cast } from "effect/Function";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpMiddleware,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
  HttpServerRespondable,
} from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { OtlpTracer } from "effect/unstable/observability";

import * as ServerConfig from "./config.ts";
import { ASSET_ROUTE_PREFIX, resolveAsset } from "./assets/AssetAccess.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { traceRelayRequest } from "./cloud/traceRelayRequest.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentScopeRequired,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
} from "./auth/http.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as TerminalBrowserOpen from "./preview/TerminalBrowserOpen.ts";
import { browserApiCorsAllowedHeaders, browserApiCorsAllowedMethods } from "./httpCors.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";

const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const DESKTOP_RENDERER_ORIGINS = ["t3code://app", "t3code-dev://app"];
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const TERMINAL_BROWSER_OPEN_MAX_URL_LENGTH = 2_048;
const TerminalBrowserOpenBody = Schema.Struct({ url: Schema.String });
const decodeTerminalBrowserOpenBody = Schema.decodeUnknownOption(TerminalBrowserOpenBody);

export function terminalBrowserOpenBearerToken(authorization: string | undefined): string | null {
  if (authorization?.startsWith("Bearer ") !== true) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export function normalizeTerminalBrowserOpenUrl(rawUrl: string): string | null {
  if (rawUrl.length > TERMINAL_BROWSER_OPEN_MAX_URL_LENGTH) return null;
  try {
    return normalizePreviewUrl(rawUrl);
  } catch {
    return null;
  }
}

export function assetResponseHeaders(filePath: string): Record<string, string> {
  return {
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    ...(filePath.toLowerCase().endsWith(".svg")
      ? { "Content-Security-Policy": SVG_CONTENT_SECURITY_POLICY }
      : {}),
  };
}

export const httpCompressionLayer = HttpRouter.middleware(HttpMiddleware.compression(), {
  global: true,
});

export const browserApiCorsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const devOrigin = config.devUrl?.origin;
    // Dev uses credentialed requests from Vite or the Electron custom origin, so both must be
    // explicit. Packaged desktop omits credentials and uses Effect's default wildcard origin.
    //
    // T3CODE_DEV_ALLOWED_ORIGINS covers dev servers reached from a second
    // origin — a tailnet name, a LAN IP, a phone. Browser dev normally proxies
    // through Vite and is same-origin (no preflight at all), so this is a
    // safety net for the desktop renderer and any direct-to-backend caller.
    return HttpRouter.cors({
      ...(devOrigin
        ? {
            allowedOrigins: [devOrigin, ...DESKTOP_RENDERER_ORIGINS, ...config.devAllowedOrigins],
            credentials: true,
          }
        : {}),
      allowedMethods: browserApiCorsAllowedMethods,
      allowedHeaders: browserApiCorsAllowedHeaders,
      maxAge: 600,
    });
  }),
);

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const authenticateRawRouteWithScope = (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
  });

export const serverEnvironmentHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "metadata",
  Effect.fnUntraced(function* (handlers) {
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    return handlers.handle(
      "descriptor",
      Effect.fn("environment.metadata.descriptor")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        return yield* serverEnvironment.getDescriptor;
      }, traceRelayRequest),
    );
  }),
);

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
  readonly bodyJson: OtlpTracer.TraceData;
}> {}

export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector.BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause, bodyJson }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to decode browser OTLP traces", {
          cause,
          bodyJson,
        }),
      ),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: HttpBody.jsonUnsafe(bodyJson),
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            cause,
            otlpTracesUrl,
          }),
        ),
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Trace export failed.", { status: 502 }),
        ),
      );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const terminalBrowserOpenRouteLayer = HttpRouter.add(
  "POST",
  TerminalBrowserOpen.TERMINAL_BROWSER_OPEN_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const browserOpen = yield* TerminalBrowserOpen.TerminalBrowserOpen;
    const token = terminalBrowserOpenBearerToken(request.headers.authorization);
    const owner = token ? yield* browserOpen.resolve(token) : undefined;
    if (!owner) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }

    const rawBody = yield* request.json.pipe(
      Effect.match({
        onFailure: () => undefined,
        onSuccess: (body) => body,
      }),
    );
    const body = decodeTerminalBrowserOpenBody(rawBody);
    if (Option.isNone(body)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const url = normalizeTerminalBrowserOpenUrl(body.value.url);
    if (!url) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    return yield* browserOpen.openInPreview({ environmentId, owner, url }).pipe(
      Effect.as(HttpServerResponse.empty({ status: 204 })),
      Effect.catch((cause) =>
        Effect.logWarning("failed to route terminal browser-open request to preview", {
          threadId: owner.threadId,
          terminalId: owner.terminalId,
          cause,
        }).pipe(
          Effect.as(
            HttpServerResponse.text("Preview host unavailable", {
              status: 503,
            }),
          ),
        ),
      ),
    );
  }),
);

export const assetRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const pullRequests = yield* PullRequestService.PullRequestService;
    return HttpRouter.add(
      "GET",
      `${ASSET_ROUTE_PREFIX}/*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (Option.isNone(url)) {
          return HttpServerResponse.text("Bad Request", { status: 400 });
        }

        const suffix = url.value.pathname.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separatorIndex = suffix.indexOf("/");
        if (separatorIndex <= 0) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }

        const asset = yield* resolveAsset(
          suffix.slice(0, separatorIndex),
          suffix.slice(separatorIndex + 1),
        );
        if (!asset) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }
        if (asset.kind === "pull-request-file") {
          const file = yield* pullRequests
            .file({
              projectId: asset.projectId,
              repository: asset.repository,
              number: asset.number,
              path: asset.path,
            })
            .pipe(
              Effect.tapError((cause) =>
                Effect.logWarning("Failed to resolve pull request image.", {
                  projectId: asset.projectId,
                  repository: asset.repository,
                  number: asset.number,
                  path: asset.path,
                  cause,
                }),
              ),
              Effect.orElseSucceed(() => null),
            );
          if (file === null) {
            return HttpServerResponse.text("Not Found", { status: 404 });
          }
          const httpClient = yield* HttpClient.HttpClient;
          const response = yield* httpClient.get(file.url).pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.tapError((cause) =>
              Effect.logWarning("Failed to download pull request image.", {
                projectId: asset.projectId,
                repository: asset.repository,
                number: asset.number,
                path: asset.path,
                errorTag: cause._tag,
              }),
            ),
            Effect.orElseSucceed(() => null),
          );
          if (response === null) {
            return HttpServerResponse.text("Not Found", { status: 404 });
          }
          return HttpServerResponse.stream(response.stream, {
            status: 200,
            contentType: Mime.getType(asset.path) ?? "application/octet-stream",
            contentLength: file.size,
            headers: {
              ...assetResponseHeaders(asset.path),
              "Cache-Control": "private, max-age=300",
            },
          });
        }
        return yield* HttpServerResponse.file(asset.path, {
          status: 200,
          headers: assetResponseHeaders(asset.path),
        }).pipe(
          Effect.orElseSucceed(() =>
            HttpServerResponse.text("Internal Server Error", { status: 500 }),
          ),
        );
      }),
    );
  }),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig.ServerConfig;
    if (config.devUrl && isDevProxiedPath(url.value.pathname)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir =
      config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
      });
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem.readFile(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
    });
  }),
);
