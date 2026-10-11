import * as NodeCrypto from "node:crypto";
import {
  DeviceEnvironmentInfo,
  DeviceDetail,
  DeviceSession,
  DevicePeerScreenshot,
  DeviceOperationError,
  type DevicePeerCommand,
  type EnvironmentDeviceHostConfig,
  type DeviceHostSummary,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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

export const makeClient = Effect.fn("EnvironmentDeviceHost.makeClient")(function* (
  config: EnvironmentDeviceHostConfig,
  token: string,
  sourceEnvironmentId: string,
) {
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const baseUrl = config.url.replace(/\/+$/, "");
  const request = <A, I>(command: DevicePeerCommand, schema: Schema.Codec<A, I>) =>
    HttpClientRequest.post(`${baseUrl}/api/device-share/command`).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
      HttpClientRequest.bodyJson(command),
      Effect.flatMap(http.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
      Effect.scoped,
      Effect.timeout("3 minutes"),
      Effect.mapError((cause) => {
        const status = HttpClientError.isHttpClientError(cause)
          ? cause.response?.status
          : undefined;
        return new DeviceOperationError({
          operation:
            status === 401
              ? "Device access expired or was revoked. Reconnect the environment"
              : status === 403
                ? "Enable device hub and agent device access on the device environment"
                : status === 503
                  ? "The device environment could not complete the request. Refresh its devices and retry"
                  : "Cannot reach the device environment from this server. Use an address reachable from both machines",
          reason: "request_failed",
          cause: status === undefined ? undefined : { httpStatus: status },
        });
      }),
    );
  const info = (operation: "inspect" | "list") =>
    request({ operation }, DeviceEnvironmentInfo).pipe(
      Effect.flatMap((value) =>
        value.environmentId === config.environmentId &&
        value.sourceEnvironmentId === sourceEnvironmentId
          ? Effect.succeed(value)
          : Effect.fail(
              new DeviceOperationError({
                operation: "connect environment devices",
                reason: "invalid_payload",
                cause: undefined,
              }),
            ),
      ),
    );
  return { request, info, baseUrl };
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
    summary = { ...info.host, id: config.id, label: config.label, kind: "environment" };
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
      origin: `${client.baseUrl}/api/device-share/hub`,
      headers: { authorization: `Bearer ${token}` },
    },
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    run: () => Effect.die(new Error("Environment device hosts use typed device operations.")),
  };
  let current: DeviceHost.DeviceHostReady | null = null;
  const hostError = (cause: unknown) =>
    new DeviceHost.DeviceHostError({ hostId: config.id, step: "connecting to environment", cause });
  const stop = client.request({ operation: "release" }, Schema.Null).pipe(
    Effect.timeout("5 seconds"),
    Effect.ignore,
    Effect.andThen(
      Effect.sync(() => {
        current = null;
      }),
    ),
  );
  yield* Effect.addFinalizer(() => (current ? stop : Effect.void));
  return DeviceHost.DeviceHost.of({
    id: config.id,
    summary: Effect.sync(() => summary),
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
      client.info("inspect").pipe(
        Effect.map(update),
        Effect.map(() => {
          current = ready;
          return ready;
        }),
        Effect.mapError(hostError),
      ),
    ensureAgentReady: () =>
      client.request({ operation: "agent" }, Schema.Null).pipe(
        Effect.map(() => {
          current = ready;
          return {
            ...ready,
            agentDevice: {
              baseUrl: `${client.baseUrl}/api/device-share/agent`,
              token,
              entryPath: "",
            },
          };
        }),
        Effect.mapError(hostError),
      ),
    current: Effect.sync(() => current),
    stopAgent: Effect.void,
    stop,
  });
});
