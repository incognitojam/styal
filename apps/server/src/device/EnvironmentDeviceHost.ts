// @effect-diagnostics-next-line nodeBuiltinImport:off -- Device host ids are derived synchronously where device state is matched.
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
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
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
/** Older environments answer a command they cannot decode with a bare 400. */
const isRejectedCommand = (cause: unknown) =>
  isHostUnavailable(cause) &&
  typeof cause.cause === "object" &&
  cause.cause !== null &&
  "httpStatus" in cause.cause &&
  cause.cause.httpStatus === 400;

/**
 * Opening a cold simulator on the device machine can wait on hub startup, memory
 * preparation, a boot, and stream attachment in turn. Starting agent-device can
 * install it first.
 */
const commandTimeout = (operation: DevicePeerCommand["operation"]): Duration.Input =>
  operation === "open" || operation === "open-low-memory"
    ? "10 minutes"
    : operation === "agent"
      ? "5 minutes"
      : "1 minute";

export const makeClient = Effect.fn("EnvironmentDeviceHost.makeClient")(function* (
  config: EnvironmentDeviceHostConfig,
  token: string,
  sourceEnvironmentId: string,
) {
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const urls = [
    ...new Set([config.url, ...(config.urls ?? [])].map((url) => url.replace(/\/+$/, ""))),
  ];
  let baseUrl = urls[0]!;
  // Cleared when the address stops answering, so the next request selects again.
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
        ? new DeviceHostUnavailableError({
            hostId: config.id,
            reason:
              "The device environment did not respond in time. Check that it is online and retry.",
            cause: { timedOut: true },
          })
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
  const send = Effect.fn("EnvironmentDeviceHost.send")(
    function* <A, I>(
      url: string,
      command: DevicePeerCommand,
      schema: Schema.Codec<A, I>,
      _timeout?: Duration.Input,
    ) {
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
    },
    (effect, _url, command, _schema, timeout = commandTimeout(command.operation)) =>
      effect.pipe(Effect.scoped, Effect.timeout(timeout)),
  );
  const checkIdentity = <A extends typeof DeviceEnvironmentIdentity.Type>(value: A) =>
    value.environmentId === config.environmentId &&
    value.sourceEnvironmentId === sourceEnvironmentId
      ? Effect.succeed(value)
      : Effect.fail(
          unavailable("This address belongs to a different environment. Reconnect device access."),
        );
  // A short timeout keeps a silent address from delaying the next one.
  const inspectAt = (url: string) =>
    send(url, { operation: "inspect" }, DeviceEnvironmentInfo, "3 seconds").pipe(
      Effect.flatMap(checkIdentity),
    );
  // Cleanup must reach the peer while device access is off, when it denies inspect.
  // Older peers reject identify, so they are checked with inspect instead.
  const identifyAt = (url: string) =>
    send(url, { operation: "identify" }, DeviceEnvironmentIdentity, "3 seconds").pipe(
      Effect.catchIf(isRejectedCommand, () => inspectAt(url)),
      Effect.flatMap(checkIdentity),
    );
  /** Uses the first address, starting with the current one, where both identities match. */
  const select = Effect.fn("EnvironmentDeviceHost.selectAddress")(function* <A, E>(
    probe: (url: string) => Effect.Effect<A, E>,
  ) {
    let failure: DeviceError = unavailable("No shared address could reach the device environment.");
    for (const url of [baseUrl, ...urls.filter((url) => url !== baseUrl)]) {
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
  // Reads and cleanup are safe to repeat, so they try another address once after a
  // transport failure. Other commands are only reported: the peer may have run one
  // before its response was lost.
  const request = <A, I>(
    command: DevicePeerCommand,
    schema: Schema.Codec<A, I>,
  ): Effect.Effect<A, DeviceError> => {
    const cleanup = ["stop-agent", "release", "revoke"].includes(command.operation);
    const attempt = Effect.gen(function* () {
      if (!verified) yield* select(cleanup ? identifyAt : inspectAt);
      return yield* send(baseUrl, command, schema).pipe(
        Effect.tapError((cause) =>
          Effect.sync(() => {
            if (isTransportFailure(cause)) verified = false;
          }),
        ),
      );
    });
    const repeatable =
      cleanup || ["inspect", "list", "detail", "screenshot"].includes(command.operation);
    return (
      repeatable && urls.length > 1
        ? attempt.pipe(Effect.retry({ times: 1, while: isTransportFailure }))
        : attempt
    ).pipe(Effect.mapError(mapError));
  };
  const info = (operation: "inspect" | "list") =>
    Effect.suspend(() =>
      operation === "inspect" && !verified
        ? select(inspectAt)
        : request({ operation }, DeviceEnvironmentInfo).pipe(Effect.flatMap(checkIdentity)),
    );
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
  const client = yield* makeClient(config, token, sourceId);
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
    open: (input, mode) =>
      mode === "low-memory"
        ? client.request({ operation: "open-low-memory", input }, DeviceSession).pipe(
            Effect.catchIf(isRejectedCommand, () =>
              client.request({ operation: "open", input }, DeviceSession).pipe(
                Effect.map((session) => ({
                  ...session,
                  notice:
                    "The device's environment runs an older styal without Low memory. The simulator started with its current memory mode.",
                })),
              ),
            ),
          )
        : client.request({ operation: "open", input }, DeviceSession),
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
    devices: {
      list: Effect.die("Typed environment operations are required"),
      boot: () => Effect.die("Typed environment operations are required"),
      attach: () => Effect.die("Typed environment operations are required"),
      shutdown: () => Effect.die("Typed environment operations are required"),
      screenshot: () => Effect.die("Typed environment operations are required"),
    },
    agentSessionNamespace: sourceId,
    nodePath: "",
    hub: {
      get origin() {
        return `${client.baseUrl}/api/device-share/hub`;
      },
      headers: { authorization: `Bearer ${token}` },
    },
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    run: () => Effect.die(new Error("Environment device hosts use typed device operations.")),
  };
  // Like the SSH host, a confirmed connection stays ready until stopped. Remote
  // operations report their own failures, so readiness does not re-check the peer.
  let current: DeviceHost.DeviceHostReady | null = null;
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
  const stopRemote = Effect.fn("EnvironmentDeviceHost.stopRemote")(function* (
    operation: "stop-agent" | "release",
  ) {
    generation += 1;
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
    // MCP structured content rejects keys set to undefined, so an unreachable host omits it.
    summary: Effect.sync(() => {
      const { connectedUrl: _peerUrl, ...rest } = summary;
      const connectedUrl = client.connectedUrl;
      return connectedUrl === undefined ? rest : { ...rest, connectedUrl };
    }),
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
            return {
              ...ready,
              agentDevice: {
                baseUrl: `${client.baseUrl}/api/device-share/agent`,
                token: agent.token,
                entryPath: "",
              },
            };
          }),
          Effect.mapError(hostError),
        );
      }),
    current: Effect.sync(() => current),
    // Drops the agent credential on the device environment. The agent-device config
    // keeps the old token, but the proxy no longer accepts it.
    stopAgent,
    stop,
  });
});
