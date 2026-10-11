import {
  AuthDeviceOperateScope,
  DeviceOperationError,
  LOCAL_DEVICE_HOST_ID,
  type DeviceHostGrant,
  type DeviceHostGrantInput,
  type DeviceConnectEnvironmentInput,
  type DevicePeerCommand,
  type DeviceError,
  type AuthSessionId,
  ThreadId,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/unstable/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceService from "./DeviceService.ts";
import {
  environmentDeviceHostId,
  environmentDeviceHostSecret,
  devicePeerThreadPrefix,
  makeClient,
} from "./EnvironmentDeviceHost.ts";

const isDeviceOperationError = Schema.is(DeviceOperationError);

const sharingError = (cause: unknown) =>
  new DeviceOperationError({
    operation: "share environment devices",
    reason: "request_failed",
    cause,
  });

export class DeviceSharing extends Context.Service<
  DeviceSharing,
  {
    readonly createGrant: (
      input: typeof DeviceHostGrantInput.Type,
    ) => Effect.Effect<DeviceHostGrant, DeviceError>;
    readonly revokeGrant: (sessionId: AuthSessionId) => Effect.Effect<void, DeviceError>;
    readonly connect: (input: DeviceConnectEnvironmentInput) => Effect.Effect<void, DeviceError>;
    readonly disconnect: (hostId: string) => Effect.Effect<void, DeviceError>;
    readonly proxyTarget: (
      agent: boolean,
    ) => Effect.Effect<{ origin: string; headers?: Readonly<Record<string, string>> }, DeviceError>;
    readonly command: (
      session: Pick<EnvironmentAuth.AuthenticatedSession, "subject" | "sessionId">,
      input: DevicePeerCommand,
    ) => Effect.Effect<unknown, DeviceError>;
  }
>()("@styal/cli/device/DeviceSharing") {}

const make = Effect.gen(function* () {
  const devices = yield* DeviceService.DeviceService;
  const http = yield* HttpClient.HttpClient;
  const settings = yield* ServerSettings.ServerSettingsService;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const lock = yield* Semaphore.make(1);
  const requireAccess = Effect.gen(function* () {
    const value = yield* settings.getSettings.pipe(Effect.mapError(sharingError));
    if (!value.enableDeviceSupport || !value.enableAgentDeviceAccess)
      return yield* new DeviceOperationError({
        operation: "Enable device hub and agent device access on the device environment first",
        reason: "hub_rejected",
        cause: undefined,
      });
  });
  const createGrant = Effect.fn("DeviceSharing.createGrant")(function* (
    input: typeof DeviceHostGrantInput.Type,
  ) {
    yield* requireAccess;
    if (input.sourceEnvironmentId === environmentId)
      return yield* new DeviceOperationError({
        operation: "This environment's devices are already local",
        reason: "invalid_payload",
        cause: undefined,
      });
    const session = yield* auth
      .issueSession({
        subject: `device-host:${input.sourceEnvironmentId}`,
        label: `Devices for ${input.sourceLabel}`,
        scopes: [AuthDeviceOperateScope],
        ttl: Duration.days(365),
      })
      .pipe(Effect.mapError(sharingError));
    return {
      environmentId,
      sourceEnvironmentId: input.sourceEnvironmentId,
      sessionId: session.sessionId,
      token: session.token,
    };
  });
  const revokeGrant = Effect.fn("DeviceSharing.revokeGrant")(function* (sessionId: AuthSessionId) {
    const sessions = yield* auth.listSessions().pipe(Effect.mapError(sharingError));
    const session = sessions.find((entry) => entry.sessionId === sessionId);
    if (
      session &&
      (session.scopes.length !== 1 ||
        session.scopes[0] !== AuthDeviceOperateScope ||
        !session.subject.startsWith("device-host:"))
    )
      return yield* new DeviceOperationError({
        operation: "revoke device access",
        reason: "invalid_payload",
        cause: undefined,
      });
    yield* auth.revokeSession(sessionId).pipe(Effect.mapError(sharingError));
  });
  const connect = Effect.fn("DeviceSharing.connect")(function* (
    input: DeviceConnectEnvironmentInput,
  ) {
    if (
      input.grant.sourceEnvironmentId !== environmentId ||
      input.grant.environmentId === environmentId
    )
      return yield* new DeviceOperationError({
        operation: "Device access was issued for another environment",
        reason: "invalid_payload",
        cause: undefined,
      });
    const url = yield* Effect.try({ try: () => new URL(input.url), catch: sharingError });
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return yield* new DeviceOperationError({
        operation: "Invalid device environment address",
        reason: "invalid_payload",
        cause: undefined,
      });
    const host = {
      id: environmentDeviceHostId(input.grant.environmentId),
      label: input.label,
      environmentId: input.grant.environmentId,
      url: url.toString().replace(/\/+$/, ""),
      sessionId: input.grant.sessionId,
    };
    const client = yield* makeClient(host, input.grant.token, environmentId).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    yield* client.info("inspect");
    const current = yield* settings.getSettings.pipe(Effect.mapError(sharingError));
    if (current.deviceHosts.some((entry) => entry.id === host.id))
      return yield* new DeviceOperationError({
        operation:
          "An SSH host already uses this device host ID. Remove that host before connecting this environment",
        reason: "invalid_payload",
        cause: undefined,
      });
    const previous = current.environmentDeviceHosts.find((entry) => entry.id === host.id);
    const previousToken = yield* secrets
      .get(environmentDeviceHostSecret(host.id))
      .pipe(Effect.mapError(sharingError));
    yield* secrets
      .set(environmentDeviceHostSecret(host.id), new TextEncoder().encode(input.grant.token))
      .pipe(Effect.mapError(sharingError));
    yield* settings
      .updateSettings({
        environmentDeviceHosts: [
          ...current.environmentDeviceHosts.filter((entry) => entry.id !== host.id),
          host,
        ],
      })
      .pipe(
        Effect.mapError(sharingError),
        Effect.onError(() =>
          (Option.isSome(previousToken)
            ? secrets.set(environmentDeviceHostSecret(host.id), previousToken.value)
            : secrets.remove(environmentDeviceHostSecret(host.id))
          ).pipe(Effect.ignore),
        ),
      );
    if (previous && previous.sessionId !== host.sessionId && Option.isSome(previousToken)) {
      const oldClient = yield* makeClient(
        previous,
        new TextDecoder().decode(previousToken.value),
        environmentId,
      ).pipe(Effect.provideService(HttpClient.HttpClient, http));
      yield* oldClient
        .request({ operation: "revoke" }, Schema.Null)
        .pipe(Effect.timeout("10 seconds"), Effect.ignore);
    }
  }, lock.withPermit);
  const disconnect = Effect.fn("DeviceSharing.disconnect")(function* (hostId: string) {
    const current = yield* settings.getSettings.pipe(Effect.mapError(sharingError));
    const host = current.environmentDeviceHosts.find((entry) => entry.id === hostId);
    if (!host) return;
    const stored = yield* secrets
      .get(environmentDeviceHostSecret(host.id))
      .pipe(Effect.mapError(sharingError));
    let revocationError: DeviceError | undefined;
    if (Option.isSome(stored)) {
      const client = yield* makeClient(
        host,
        new TextDecoder().decode(stored.value),
        environmentId,
      ).pipe(Effect.provideService(HttpClient.HttpClient, http));
      yield* client.request({ operation: "revoke" }, Schema.Null).pipe(
        Effect.timeout("10 seconds"),
        Effect.catch((error) =>
          Effect.sync(() => {
            if (
              !(
                isDeviceOperationError(error) &&
                typeof error.cause === "object" &&
                error.cause !== null &&
                "httpStatus" in error.cause &&
                error.cause.httpStatus === 401
              )
            )
              revocationError = new DeviceOperationError({
                operation:
                  "Device host removed locally. The remote environment could not be reached; revoke its Devices for this environment session in Connections",
                reason: "request_failed",
                cause: undefined,
              });
          }),
        ),
      );
    }
    yield* settings
      .updateSettings({
        environmentDeviceHosts: current.environmentDeviceHosts.filter(
          (entry) => entry.id !== hostId,
        ),
      })
      .pipe(Effect.mapError(sharingError));
    yield* secrets.remove(environmentDeviceHostSecret(host.id)).pipe(Effect.mapError(sharingError));
    if (revocationError) return yield* revocationError;
  }, lock.withPermit);
  const command = Effect.fn("DeviceSharing.command")(function* (
    session: Pick<EnvironmentAuth.AuthenticatedSession, "subject" | "sessionId">,
    input: DevicePeerCommand,
  ) {
    const sourceId = session.subject.slice("device-host:".length);
    if (!session.subject.startsWith("device-host:") || !sourceId)
      return yield* new DeviceOperationError({
        operation: "Invalid device access credential",
        reason: "invalid_payload",
        cause: undefined,
      });
    const prefix = devicePeerThreadPrefix(sourceId);
    const thread = (id: string) => ThreadId.make(`${prefix}${id}`);
    if (input.operation === "revoke" || input.operation === "release") {
      const state = yield* devices.state;
      for (const open of state.sessions.filter((entry) => entry.threadId.startsWith(prefix)))
        yield* devices.close({ threadId: open.threadId, hostId: LOCAL_DEVICE_HOST_ID });
      if (input.operation === "revoke")
        yield* auth.revokeSession(session.sessionId).pipe(Effect.mapError(sharingError));
      return null;
    }
    yield* requireAccess;
    switch (input.operation) {
      case "inspect":
      case "list": {
        // Traversing peer hosts here would recurse when environments share
        // devices in both directions. Inspect only published local state.
        const state = yield* input.operation === "inspect"
          ? devices.state
          : devices.listHost(LOCAL_DEVICE_HOST_ID);
        const host = state.hosts.find((entry) => entry.id === LOCAL_DEVICE_HOST_ID);
        if (!host)
          return yield* new DeviceOperationError({
            operation: "Local device host is unavailable",
            reason: "hub_rejected",
            cause: undefined,
          });
        return {
          environmentId,
          sourceEnvironmentId: EnvironmentId.make(sourceId),
          host,
          devices: state.devices.filter((entry) => entry.hostId === LOCAL_DEVICE_HOST_ID),
          sessions: state.sessions.filter((entry) => entry.hostId === LOCAL_DEVICE_HOST_ID),
        };
      }
      case "agent": {
        const ready = yield* devices.agentReadinessIfSupported(LOCAL_DEVICE_HOST_ID);
        if (!ready)
          return yield* new DeviceOperationError({
            operation: "Agent device access is unavailable",
            reason: "hub_rejected",
            cause: undefined,
          });
        return null;
      }
      case "open":
        return yield* devices.open({
          ...input.input,
          hostId: LOCAL_DEVICE_HOST_ID,
          threadId: thread(input.input.threadId),
        });
      case "close":
        yield* devices.close({
          ...input.input,
          hostId: LOCAL_DEVICE_HOST_ID,
          threadId: thread(input.input.threadId),
        });
        return null;
      case "shutdown":
        yield* devices.shutdown({ ...input.input, hostId: LOCAL_DEVICE_HOST_ID });
        return null;
      case "detail":
        return yield* devices.detail({ ...input.input, hostId: LOCAL_DEVICE_HOST_ID });
      case "action":
        return yield* devices.action({ ...input.input, hostId: LOCAL_DEVICE_HOST_ID });
      case "screenshot": {
        const shot = yield* devices.screenshot({ ...input.input, hostId: LOCAL_DEVICE_HOST_ID });
        return { device: shot.device, png: Buffer.from(shot.png).toString("base64") };
      }
    }
  });
  const proxyTarget = Effect.fn("DeviceSharing.proxyTarget")(function* (agent: boolean) {
    yield* requireAccess;
    if (agent) {
      const ready = yield* devices.agentReadinessIfSupported(LOCAL_DEVICE_HOST_ID);
      if (!ready)
        return yield* new DeviceOperationError({
          operation: "Agent device access is unavailable",
          reason: "hub_rejected",
          cause: undefined,
        });
      return {
        origin: ready.agentDevice.baseUrl,
        headers: {
          authorization: `Bearer ${ready.agentDevice.token}`,
          "x-agent-device-token": ready.agentDevice.token,
        },
      };
    }
    const ready = yield* devices.readinessIfSupported(LOCAL_DEVICE_HOST_ID);
    if (!ready)
      return yield* new DeviceOperationError({
        operation: "Device hub is unavailable",
        reason: "hub_rejected",
        cause: undefined,
      });
    return { origin: ready.hub.origin };
  });
  return DeviceSharing.of({ createGrant, revokeGrant, connect, disconnect, command, proxyTarget });
});

export const layer = Layer.effect(DeviceSharing, make);
