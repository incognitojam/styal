import * as NodeCrypto from "node:crypto";
import {
  DeviceEnvironmentInfo,
  DeviceEnvironmentIdentity,
  DeviceDetail,
  DeviceError,
  DeviceHostUnavailableError,
  DevicePeerAgent,
  DeviceSession,
  DevicePeerScreenshot,
  type DevicePeerCommand,
  type EnvironmentDeviceHostConfig,
  type DeviceHostSummary,
  ThreadId,
  EnvironmentId,
} from "@t3tools/contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as DeviceHost from "./DeviceHost.ts";

export const environmentDeviceHostId = (id: string) =>
  `environment-${NodeCrypto.createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
export const environmentDeviceHostSecret = (id: string) =>
  `device-host-${NodeCrypto.createHash("sha256").update(id).digest("hex")}`;
export const devicePeerThreadPrefix = (environmentId: string) =>
  `device-peer-${environmentDeviceHostId(environmentId)}:`;

const isDeviceError = Schema.is(DeviceError);
const decodeDeviceError = Schema.decodeUnknownOption(DeviceError);
const isHostUnavailable = Schema.is(DeviceHostUnavailableError);

/**
 * Opening a cold simulator on the device machine can wait on hub startup, a boot,
 * and the iOS stream attach in turn. Starting agent-device can install it first.
 */
const commandTimeout = (operation: DevicePeerCommand["operation"]): Duration.Input =>
  operation === "open" ? "10 minutes" : operation === "agent" ? "5 minutes" : "1 minute";

export const makeClient = Effect.fn("EnvironmentDeviceHost.makeClient")(function* (
  config: EnvironmentDeviceHostConfig,
  token: string,
  sourceEnvironmentId: string,
  options?: { readonly verifiedSavedUrl: string },
) {
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const urls = [
    ...new Set([config.url, ...(config.urls ?? [])].map((url) => url.replace(/\/+$/, ""))),
  ];
  let baseUrl = urls[0]!;
  let verified = false;
  const unavailable = (reason: string, httpStatus?: number) =>
    new DeviceHostUnavailableError({
      hostId: config.id,
      reason,
      cause: httpStatus === undefined ? undefined : { httpStatus },
    });
  const mapError = (cause: unknown) =>
    isDeviceError(cause)
      ? cause
      : Cause.isTimeoutError(cause)
        ? unavailable(
            "The device environment did not respond in time. Check that it is online and retry.",
          )
        : HttpClientError.isHttpClientError(cause)
          ? unavailable(
              "Cannot reach the device environment at any shared address. Check that it is online and reachable from this machine, for example over Tailscale.",
            )
          : unavailable(
              "The device environment sent an unexpected response. Update both environments and retry.",
            );
  const isTransportFailure = (cause: unknown) =>
    Cause.isTimeoutError(cause) ||
    (HttpClientError.isHttpClientError(cause) && cause.reason._tag === "TransportError");
  const isEndpointFailure = (cause: unknown) =>
    isTransportFailure(cause) ||
    (isHostUnavailable(cause) &&
      typeof cause.cause === "object" &&
      cause.cause !== null &&
      "httpStatus" in cause.cause &&
      [502, 503, 504].includes(Number(cause.cause.httpStatus)));
  // Only these failures establish that the command never reached the peer. A
  // lost response or timeout may follow a completed action, so cannot replay it.
  const failedBeforeSend = (cause: unknown): boolean => {
    if (typeof cause !== "object" || cause === null) return false;
    if (
      "code" in cause &&
      typeof cause.code === "string" &&
      ["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN"].includes(cause.code)
    )
      return true;
    return "cause" in cause && failedBeforeSend(cause.cause);
  };
  /** Restores a typed error from the device environment, pointed at this host entry. */
  const remoteError = (body: unknown) => {
    const error =
      typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
    return decodeDeviceError(
      typeof error === "object" && error !== null && "hostId" in error
        ? { ...error, hostId: config.id }
        : error,
    );
  };
  const send = <A, I>(
    url: string,
    command: DevicePeerCommand,
    schema: Schema.Codec<A, I>,
    timeout: Duration.Input = commandTimeout(command.operation),
  ) =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(`${url}/api/device-share/command`).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
        HttpClientRequest.bodyJson(command),
        Effect.flatMap(http.execute),
      );
      if (response.status >= 200 && response.status < 300)
        return yield* HttpClientResponse.schemaBodyJson(schema)(response);
      const error = Option.flatMap(yield* Effect.option(response.json), remoteError);
      return yield* Option.isSome(error)
        ? error.value
        : response.status === 401
          ? unavailable("Device access expired or was revoked. Reconnect the environment.", 401)
          : unavailable(
              `The device environment could not complete the request (HTTP ${response.status}). Update both environments and retry.`,
              response.status,
            );
    }).pipe(Effect.scoped, Effect.timeout(timeout));
  const checkIdentity = <A extends typeof DeviceEnvironmentIdentity.Type>(value: A) =>
    value.environmentId === config.environmentId &&
    value.sourceEnvironmentId === sourceEnvironmentId
      ? Effect.succeed(value)
      : Effect.fail(
          unavailable("This address belongs to a different environment. Reconnect device access."),
        );
  const inspectAt = (url: string) =>
    send(url, { operation: "inspect" }, DeviceEnvironmentInfo, "3 seconds").pipe(
      Effect.flatMap(checkIdentity),
    );
  const identifyAt = (url: string) =>
    send(url, { operation: "identify" }, DeviceEnvironmentIdentity, "3 seconds").pipe(
      // Older peers authenticate before rejecting identify. Only their saved,
      // previously verified address can use that grant for cleanup without inspect,
      // which they deny while device access is off. Alternatives still need both IDs.
      Effect.catchIf(
        (cause) =>
          isHostUnavailable(cause) &&
          typeof cause.cause === "object" &&
          cause.cause !== null &&
          "httpStatus" in cause.cause &&
          cause.cause.httpStatus === 400,
        () =>
          url === options?.verifiedSavedUrl.replace(/\/+$/, "")
            ? Effect.succeed({
                environmentId: config.environmentId,
                sourceEnvironmentId: EnvironmentId.make(sourceEnvironmentId),
              })
            : inspectAt(url),
      ),
      Effect.flatMap(checkIdentity),
    );
  const select = Effect.fn("EnvironmentDeviceHost.selectAddress")(function* <A, E>(
    probe: (url: string) => Effect.Effect<A, E>,
    skip?: string,
  ) {
    let failure: DeviceError = unavailable(
      "No other shared address could reach the device environment.",
    );
    for (const url of [baseUrl, ...urls.filter((url) => url !== baseUrl)].filter(
      (url) => url !== skip,
    )) {
      const result = yield* probe(url).pipe(Effect.result);
      if (result._tag === "Success") {
        baseUrl = url;
        verified = true;
        return result.success;
      }
      failure = mapError(result.failure);
    }
    if (urls.every((url) => isLocalLoopbackHost(new URL(url).hostname)))
      return yield* unavailable(
        "This server could not reach the device environment. Loopback addresses only work when both environments run on the same machine.",
      );
    return yield* failure;
  });
  const request = <A, I>(
    command: DevicePeerCommand,
    schema: Schema.Codec<A, I>,
  ): Effect.Effect<A, DeviceError> =>
    Effect.gen(function* () {
      const probe = ["stop-agent", "release", "revoke"].includes(command.operation)
        ? identifyAt
        : inspectAt;
      if (!verified) yield* select(probe);
      const attempted = baseUrl;
      return yield* send(attempted, command, schema).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            if (!isEndpointFailure(cause)) return yield* Effect.fail(cause);
            verified = false;
            if (
              urls.length === 1 ||
              (!failedBeforeSend(cause) &&
                !["inspect", "list", "detail", "screenshot"].includes(command.operation))
            )
              return yield* Effect.fail(cause);
            yield* select(probe, attempted);
            return yield* send(baseUrl, command, schema);
          }),
        ),
      );
    }).pipe(Effect.mapError(mapError));
  const info = (operation: "inspect" | "list") =>
    operation === "inspect"
      ? Effect.suspend(() =>
          verified
            ? inspectAt(baseUrl).pipe(
                Effect.catch((cause) => {
                  verified = false;
                  if (urls.length === 1) return Effect.fail(mapError(cause));
                  return select(inspectAt, baseUrl);
                }),
              )
            : select(inspectAt),
        )
      : request({ operation }, DeviceEnvironmentInfo).pipe(Effect.flatMap(checkIdentity));
  return {
    request,
    info,
    get baseUrl() {
      return baseUrl;
    },
    get connectedUrl() {
      return verified ? baseUrl : undefined;
    },
  };
});

export const make = Effect.fn("EnvironmentDeviceHost.make")(function* (
  config: EnvironmentDeviceHostConfig,
) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const sourceId = yield* environment.getEnvironmentId;
  const stored = yield* secrets.get(environmentDeviceHostSecret(config.id)).pipe(
    Effect.mapError(
      (cause) =>
        new DeviceHost.DeviceHostError({
          hostId: config.id,
          step: "reading device access",
          cause,
        }),
    ),
  );
  const token = Option.isSome(stored) ? new TextDecoder().decode(stored.value) : "";
  const client = yield* makeClient(config, token, sourceId, { verifiedSavedUrl: config.url });
  let summary: DeviceHostSummary = {
    id: config.id,
    label: config.label,
    kind: "environment",
    platforms: [],
    hubInstalled: false,
    agentDeviceInstalled: false,
  };
  const update = (info: DeviceEnvironmentInfo) => {
    summary = {
      ...info.host,
      id: config.id,
      label: config.label,
      kind: "environment",
      connectedUrl: client.baseUrl,
    };
    const prefix = devicePeerThreadPrefix(sourceId);
    return {
      ...info,
      devices: info.devices.map((device) => ({ ...device, hostId: config.id })),
      sessions: info.sessions.map((session) => ({
        ...session,
        hostId: config.id,
        threadId: ThreadId.make(
          session.threadId.startsWith(prefix)
            ? session.threadId.slice(prefix.length)
            : `${devicePeerThreadPrefix(config.environmentId)}${session.threadId}`,
        ),
      })),
    };
  };
  const remote: NonNullable<DeviceHost.DeviceHostReady["remote"]> = {
    list: client.info("list").pipe(Effect.map(update)),
    open: (input) => client.request({ operation: "open", input }, DeviceSession),
    close: (input) =>
      client.request({ operation: "close", input }, Schema.Null).pipe(Effect.asVoid),
    shutdown: (input) =>
      client.request({ operation: "shutdown", input }, Schema.Null).pipe(Effect.asVoid),
    detail: (input) => client.request({ operation: "detail", input }, DeviceDetail),
    action: (input) => client.request({ operation: "action", input }, DeviceDetail),
    screenshot: (input) =>
      client.request({ operation: "screenshot", input }, DevicePeerScreenshot).pipe(
        Effect.map((value) => ({
          device: { ...value.device, hostId: config.id },
          png: new Uint8Array(Buffer.from(value.png, "base64")),
        })),
      ),
  };
  const ready: DeviceHost.DeviceHostReady = {
    remote,
    agentSessionNamespace: sourceId,
    nodePath: "",
    hub: {
      get origin() {
        return `${client.baseUrl}/api/device-share/hub`;
      },
      headers: { authorization: `Bearer ${token}` },
      resolve: client.info("inspect").pipe(
        Effect.map(() => ({
          origin: `${client.baseUrl}/api/device-share/hub`,
          headers: { authorization: `Bearer ${token}` },
        })),
      ),
    },
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    run: () => Effect.die(new Error("Environment device hosts use typed device operations.")),
  };
  // Like the SSH host, a confirmed connection stays ready until stopped. Remote
  // operations report their own failures, so readiness does not re-check the peer.
  let current: DeviceHost.DeviceHostReady | null = null;
  let agentEndpoint: DeviceHost.AgentDeviceEndpoint | null = null;
  const hostError = (cause: unknown) =>
    new DeviceHost.DeviceHostError({ hostId: config.id, step: "connecting to environment", cause });
  // Readiness calls run without the device lifecycle lock, so one can finish after
  // stop. Each stop starts a new generation, and late results from an older one are dropped.
  let generation = 0;
  const scope = yield* Effect.scope;
  let pendingStop: Fiber.Fiber<void> | null = null;
  const cancelPendingStop = Effect.suspend(() => {
    const fiber = pendingStop;
    pendingStop = null;
    return fiber ? Fiber.interrupt(fiber) : Effect.void;
  });
  /**
   * Tells the device environment to drop this environment's agent credential, or all
   * of its sessions for "release". An unreachable peer is retried in the background so
   * the credential cannot come back into use when it returns; starting agent access
   * again cancels the retry.
   */
  const stopRemote = (operation: "stop-agent" | "release") =>
    Effect.gen(function* () {
      generation += 1;
      agentEndpoint = null;
      yield* cancelPendingStop;
      const attempt = client.request({ operation }, Schema.Null);
      const exit = yield* attempt.pipe(Effect.timeout("5 seconds"), Effect.exit);
      if (Exit.isFailure(exit))
        pendingStop = yield* attempt.pipe(
          Effect.retry(Schedule.spaced("30 seconds")),
          Effect.ignore,
          Effect.forkIn(scope),
        );
    });
  const stopAgent = stopRemote("stop-agent");
  const stale = (started: number): Effect.Effect<void, DeviceHostUnavailableError> =>
    started === generation
      ? Effect.void
      : Effect.fail(
          new DeviceHostUnavailableError({
            hostId: config.id,
            reason: "Device access to this environment was stopped. Retry the operation.",
          }),
        );
  const stop = stopRemote("release").pipe(
    Effect.andThen(
      Effect.sync(() => {
        current = null;
      }),
    ),
  );
  // The host scope is closing here, so this is a single attempt without a retry.
  yield* Effect.addFinalizer(() =>
    current
      ? client
          .request({ operation: "release" }, Schema.Null)
          .pipe(Effect.timeout("5 seconds"), Effect.ignore)
      : Effect.void,
  );
  return DeviceHost.DeviceHost.of({
    id: config.id,
    summary: Effect.sync(() => ({ ...summary, connectedUrl: client.connectedUrl })),
    inspect: client.info("inspect").pipe(
      Effect.map(update),
      Effect.map(() => summary),
      Effect.mapError(hostError),
    ),
    platformAvailability: (platform) =>
      Effect.succeed(
        summary.platforms.find((entry) => entry.platform === platform) ?? {
          platform,
          available: true,
        },
      ),
    ensureReady: () =>
      Effect.suspend(() => {
        if (current) return Effect.succeed(current);
        const started = generation;
        return client.info("inspect").pipe(
          Effect.tap(() => stale(started)),
          Effect.map(update),
          Effect.map(() => {
            current = ready;
            return ready;
          }),
          Effect.mapError(hostError),
        );
      }),
    ensureAgentReady: () =>
      Effect.suspend(() => {
        const started = generation;
        return cancelPendingStop.pipe(
          Effect.andThen(client.request({ operation: "agent" }, DevicePeerAgent)),
          Effect.tap(() => stale(started).pipe(Effect.tapError(() => stopAgent))),
          Effect.map((agent) => {
            current = ready;
            agentEndpoint = {
              get baseUrl() {
                return `${client.baseUrl}/api/device-share/agent`;
              },
              token: agent.token,
              entryPath: "",
            };
            return {
              ...ready,
              agentDevice: agentEndpoint,
            };
          }),
          Effect.mapError(hostError),
        );
      }),
    current: Effect.sync(() => current),
    currentAgent: Effect.sync(() => agentEndpoint),
    // Drops the agent credential on the device environment. The agent-device config
    // keeps the old token, but the proxy no longer accepts it.
    stopAgent,
    stop,
  });
});
