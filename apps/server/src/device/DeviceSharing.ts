import * as NodeCrypto from "node:crypto";
import {
  AuthDeviceOperateScope,
  DeviceHostUnavailableError,
  DeviceOperationError,
  LOCAL_DEVICE_HOST_ID,
  type DeviceHostGrant,
  type DeviceHostGrantInput,
  type DeviceConnectEnvironmentInput,
  type DevicePeerCommand,
  type DeviceError,
  type DeviceHostId,
  type AuthSessionId,
  ThreadId,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
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

const sharingError = (cause: unknown) =>
  new DeviceHostUnavailableError({
    hostId: LOCAL_DEVICE_HOST_ID,
    reason: "Device sharing could not read or save its settings or credentials. Retry.",
    cause,
  });
/** User-facing failure. Remote callers rewrite `hostId` to their own host entry. */
const unavailable = (reason: string, hostId: DeviceHostId = LOCAL_DEVICE_HOST_ID) =>
  new DeviceHostUnavailableError({ hostId, reason });
const sameToken = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
};
/** How long a session check covers agent proxy requests before the grant is checked again. */
const AGENT_SESSION_CHECK_MS = 30_000;

export class DeviceSharing extends Context.Service<
  DeviceSharing,
  {
    readonly createGrant: (
      input: typeof DeviceHostGrantInput.Type,
    ) => Effect.Effect<DeviceHostGrant, DeviceError>;
    readonly revokeGrant: (sessionId: AuthSessionId) => Effect.Effect<void, DeviceError>;
    readonly connect: (input: DeviceConnectEnvironmentInput) => Effect.Effect<void, DeviceError>;
    readonly disconnect: (hostId: string) => Effect.Effect<void, DeviceError>;
    readonly hubTarget: Effect.Effect<{ origin: string }, DeviceError>;
    /** Resolves an agent proxy credential. Null means the credential is unknown or revoked. */
    readonly agentTarget: (
      token: string,
    ) => Effect.Effect<
      { origin: string; headers: Readonly<Record<string, string>> } | null,
      DeviceError
    >;
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
  // Agent credentials live only in memory. A restart, a stop-agent, release, or revoke
  // command, or finding local device or agent access off drops them. The source gets a
  // new one the next time an agent opens a device.
  const agents = new Map<AuthSessionId, { token: string; checkedAt: number }>();
  const requireAccess = Effect.gen(function* () {
    const value = yield* settings.getSettings.pipe(Effect.mapError(sharingError));
    if (!value.enableDeviceSupport || !value.enableAgentDeviceAccess)
      return yield* unavailable(
        "Enable device hub and agent device access on the device environment first.",
      );
  });
  const createGrant = Effect.fn("DeviceSharing.createGrant")(function* (
    input: typeof DeviceHostGrantInput.Type,
  ) {
    yield* requireAccess;
    if (input.sourceEnvironmentId === environmentId)
      return yield* unavailable("This environment's devices are already local.");
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
      return yield* unavailable("This session is not a device access grant.");
    agents.delete(sessionId);
    yield* auth.revokeSession(sessionId).pipe(Effect.mapError(sharingError));
  });
  const connect = Effect.fn("DeviceSharing.connect")(function* (
    input: DeviceConnectEnvironmentInput,
  ) {
    const hostId = environmentDeviceHostId(input.grant.environmentId);
    if (
      input.grant.sourceEnvironmentId !== environmentId ||
      input.grant.environmentId === environmentId
    )
      return yield* unavailable("Device access was issued for another environment.", hostId);
    const url = yield* Effect.try({ try: () => new URL(input.url), catch: sharingError });
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return yield* unavailable("Invalid device environment address.", hostId);
    const host = {
      id: hostId,
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
      return yield* unavailable(
        "An SSH host already uses this device host ID. Remove that host before connecting this environment.",
        host.id,
      );
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
                typeof error.cause === "object" &&
                error.cause !== null &&
                "httpStatus" in error.cause &&
                error.cause.httpStatus === 401
              )
            )
              revocationError = unavailable(
                "Device host removed locally. The remote environment could not be reached; revoke its Devices for this environment session in Connections.",
                host.id,
              );
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
      return yield* unavailable("Invalid device access credential.");
    const prefix = devicePeerThreadPrefix(sourceId);
    const thread = (id: string) => ThreadId.make(`${prefix}${id}`);
    if (input.operation === "stop-agent") {
      agents.delete(session.sessionId);
      return null;
    }
    if (input.operation === "revoke" || input.operation === "release") {
      agents.delete(session.sessionId);
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
        if (!host) return yield* unavailable("The device environment has no local device host.");
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
          return yield* unavailable(
            "Agent device access is unavailable on the device environment.",
          );
        const token =
          agents.get(session.sessionId)?.token ?? NodeCrypto.randomBytes(32).toString("base64url");
        agents.set(session.sessionId, { token, checkedAt: yield* Clock.currentTimeMillis });
        return { token };
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
  const hubTarget = Effect.gen(function* () {
    yield* requireAccess;
    const ready = yield* devices.readinessIfSupported(LOCAL_DEVICE_HOST_ID);
    if (!ready) return yield* unavailable("Device hub is unavailable on the device environment.");
    return { origin: ready.hub.origin };
  });
  const agentTarget = Effect.fn("DeviceSharing.agentTarget")(function* (token: string) {
    const match = [...agents].find(([, entry]) => sameToken(entry.token, token));
    if (!match) return null;
    yield* requireAccess.pipe(Effect.tapError(() => Effect.sync(() => agents.clear())));
    const [sessionId, entry] = match;
    const now = yield* Clock.currentTimeMillis;
    if (now - entry.checkedAt > AGENT_SESSION_CHECK_MS) {
      // Grants revoked from Connections settings bypass this service, so confirm the
      // session is still active before forwarding.
      const sessions = yield* auth.listSessions().pipe(Effect.mapError(sharingError));
      if (!sessions.some((candidate) => candidate.sessionId === sessionId)) {
        agents.delete(sessionId);
        return null;
      }
      agents.set(sessionId, { ...entry, checkedAt: now });
    }
    // Read without the lifecycle lock so proxied requests neither wait on device work nor
    // publish state. The daemon's port and token change when it restarts.
    const endpoint = yield* devices.currentAgentEndpoint(LOCAL_DEVICE_HOST_ID);
    if (!endpoint)
      return yield* unavailable("Agent device access is unavailable on the device environment.");
    return {
      origin: endpoint.baseUrl,
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        "x-agent-device-token": endpoint.token,
        // agent-device's own remote proxy sends this. It makes the daemon refuse
        // installs from local paths and limits its network requests to public addresses.
        "x-agent-device-network-access": "public-only",
      },
    };
  });
  return DeviceSharing.of({
    createGrant,
    revokeGrant,
    connect,
    disconnect,
    command,
    hubTarget,
    agentTarget,
  });
});

export const layer = Layer.effect(DeviceSharing, make);
