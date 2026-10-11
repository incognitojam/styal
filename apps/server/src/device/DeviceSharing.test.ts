import { it, expect } from "@effect/vitest";
import {
  AuthDeviceOperateScope,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  DEFAULT_SERVER_SETTINGS,
  DeviceNotFoundError,
  DevicePeerAgent,
  ServerSettings as ServerSettingsSchema,
  ServerSettingsError,
  EnvironmentId,
  ThreadId,
  LOCAL_DEVICE_HOST_ID,
  type ServerSettings,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/unstable/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as DeviceService from "./DeviceService.ts";
import * as DeviceSharing from "./DeviceSharing.ts";
import * as EnvironmentDeviceHost from "./EnvironmentDeviceHost.ts";
import {
  deviceSharingRouteLayer,
  deviceSharingProxyRouteLayer,
  deviceSharingAgentRouteLayer,
} from "./DeviceSharingHttp.ts";

const encodeSettings = Schema.encodeSync(Schema.fromJsonString(ServerSettingsSchema));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodePeerAgent = Schema.decodeUnknownSync(DevicePeerAgent);
const decodeCommandBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ operation: Schema.String })),
);

const sourceId = EnvironmentId.make("atlas");
const targetId = EnvironmentId.make("orion");
const settingsFixture = () => {
  let failWrites = false;
  let value: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    enableDeviceSupport: true,
    enableAgentDeviceAccess: true,
  };
  const service = ServerSettingsService.ServerSettingsService.of({
    start: Effect.void,
    ready: Effect.void,
    getSettings: Effect.sync(() => value),
    updateSettings: (patch) =>
      Effect.suspend(() => {
        if (failWrites)
          return Effect.fail(
            new ServerSettingsError({
              settingsPath: "/synthetic/settings.json",
              operation: "write-file",
              cause: undefined,
            }),
          );
        value = {
          ...value,
          environmentDeviceHosts: patch.environmentDeviceHosts ?? value.environmentDeviceHosts,
          deviceHosts: patch.deviceHosts ?? value.deviceHosts,
          enableDeviceSupport: patch.enableDeviceSupport ?? value.enableDeviceSupport,
          enableAgentDeviceAccess: patch.enableAgentDeviceAccess ?? value.enableAgentDeviceAccess,
        };
        return Effect.succeed(value);
      }),
    subscribeChanges: Effect.succeed(Stream.empty),
    streamChanges: Stream.empty,
  });
  return {
    service,
    read: () => value,
    failWrites: (fail: boolean) => {
      failWrites = fail;
    },
  };
};
const secretsFixture = () => {
  const entries = new Map<string, Uint8Array>();
  const layer = Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: (key) => Effect.sync(() => Option.fromNullishOr(entries.get(key))),
    set: (key, value) =>
      Effect.sync(() => {
        entries.set(key, value);
      }),
    remove: (key) =>
      Effect.sync(() => {
        entries.delete(key);
      }),
  });
  return { entries, layer };
};
const environmentLayer = (id: EnvironmentId) =>
  Layer.mock(ServerEnvironment.ServerEnvironment)({ getEnvironmentId: Effect.succeed(id) });

const fixture = Effect.gen(function* () {
  const targetSettings = settingsFixture();
  const sourceSettings = settingsFixture();
  const secrets = secretsFixture();
  const active = new Map<string, EnvironmentAuth.AuthenticatedSession>();
  const grants: ReadonlyArray<AuthEnvironmentScope>[] = [];
  const revoked: string[] = [];
  const daemonRequests: {
    url: string;
    headers: Readonly<Record<string, string>>;
    body: string | undefined;
  }[] = [];
  let unavailable = false;
  // Peer commands the target finished handling, as "operation:status".
  const commands = yield* Queue.unbounded<string>();
  let inventoryUnavailable = false;
  let handler: (request: Request) => Promise<Response>;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.url.startsWith("http://orion.test")) {
        if (unavailable)
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }));
        const body =
          request.body._tag === "Uint8Array"
            ? new TextDecoder().decode(request.body.body)
            : undefined;
        const response = yield* Effect.promise(() =>
          handler(
            new Request(request.url, {
              method: request.method,
              headers: request.headers,
              ...(body ? { body } : {}),
            }),
          ),
        );
        if (request.url.endsWith("/api/device-share/command") && body)
          yield* Queue.offer(commands, `${decodeCommandBody(body).operation}:${response.status}`);
        return HttpClientResponse.fromWeb(request, response);
      }
      if (request.url.startsWith("http://daemon.test")) {
        daemonRequests.push({
          url: request.url,
          headers: request.headers,
          body:
            request.body._tag === "Uint8Array"
              ? new TextDecoder().decode(request.body.body)
              : undefined,
        });
        return HttpClientResponse.fromWeb(request, Response.json({ ok: true }));
      }
      if (inventoryUnavailable)
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }));
      const response = request.url.includes("/api/devices")
        ? {
            simulators: [],
            emulators: [
              {
                id: "emulator-5554",
                platform: "android",
                name: "Pixel",
                booted: true,
                physical: false,
                version: "Android 17",
              },
            ],
          }
        : { ok: true };
      return HttpClientResponse.fromWeb(request, Response.json(response));
    }),
  );
  const authLayer = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    issueSession: (input) =>
      Effect.sync(() => {
        const sessionId = AuthSessionId.make(`device-${active.size}`);
        const token = `synthetic-${sessionId}`;
        const scopes = input?.scopes ?? [];
        grants.push(scopes);
        const session: EnvironmentAuth.AuthenticatedSession = {
          sessionId,
          subject: input?.subject ?? "user",
          scopes,
          method: "bearer-access-token",
        };
        active.set(token, session);
        return {
          ...session,
          method: "bearer-access-token" as const,
          token,
          client: { deviceType: "unknown" as const },
          expiresAt: DateTime.makeUnsafe("2027-01-01"),
        };
      }),
    revokeSession: (id) =>
      Effect.sync(() => {
        revoked.push(id);
        for (const [token, session] of active) if (session.sessionId === id) active.delete(token);
        return true;
      }),
    listSessions: () =>
      Effect.sync(() =>
        [...active.values()].map((session) => ({
          ...session,
          client: { deviceType: "unknown" as const },
          issuedAt: DateTime.makeUnsafe("2026-01-01"),
          expiresAt: DateTime.makeUnsafe("2027-01-01"),
          lastConnectedAt: null,
          connected: false,
          current: false,
        })),
      ),
    authenticateHttpRequest: (request) =>
      Effect.suspend(() => {
        const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
        const session = active.get(token);
        return session
          ? Effect.succeed(session)
          : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}));
      }),
  });
  let daemon: DeviceHost.AgentDeviceEndpoint = {
    baseUrl: "http://daemon.test",
    token: "synthetic-daemon-token",
    entryPath: "/driver",
  };
  const ready: DeviceHost.DeviceHostAgentReady = {
    nodePath: process.execPath,
    hub: { origin: "http://hub.test" },
    helpers: { serveSimCli: null, serveSimAxSettings: null },
    run: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
    agentDevice: {
      baseUrl: "http://daemon.test",
      token: "synthetic-daemon-token",
      entryPath: "/driver",
    },
  };
  const local = DeviceHost.DeviceHost.of({
    id: LOCAL_DEVICE_HOST_ID,
    summary: Effect.succeed({
      id: LOCAL_DEVICE_HOST_ID,
      kind: "local",
      label: "Orion",
      platforms: [{ platform: "android", available: true }],
      hubInstalled: true,
      agentDeviceInstalled: true,
    }),
    platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
    ensureReady: () => Effect.succeed(ready),
    ensureAgentReady: () => Effect.succeed(ready),
    current: Effect.succeed(ready),
    currentAgent: Effect.sync(() => daemon),
    stopAgent: Effect.void,
    stop: Effect.void,
  });
  const targetDevices = yield* DeviceService.makeWithHosts(new Map([[local.id, local]])).pipe(
    Effect.provideService(ServerSettingsService.ServerSettingsService, targetSettings.service),
    Effect.provideService(HttpClient.HttpClient, http),
  );
  const targetLayer = DeviceSharing.layer.pipe(
    Layer.provideMerge(Layer.succeed(DeviceService.DeviceService, targetDevices)),
    Layer.provideMerge(
      Layer.succeed(ServerSettingsService.ServerSettingsService, targetSettings.service),
    ),
    Layer.provideMerge(authLayer),
    Layer.provideMerge(secrets.layer),
    Layer.provideMerge(environmentLayer(targetId)),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, http)),
  );
  const target = yield* DeviceSharing.DeviceSharing.pipe(Effect.provide(targetLayer));
  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(
      deviceSharingRouteLayer,
      deviceSharingProxyRouteLayer,
      deviceSharingAgentRouteLayer,
    ).pipe(Layer.provideMerge(targetLayer)),
    { disableLogger: true },
  );
  handler = (request) => web.handler(request);
  yield* Effect.addFinalizer(() => Effect.promise(web.dispose));
  const sourceLayer = DeviceSharing.layer.pipe(
    Layer.provide(Layer.succeed(DeviceService.DeviceService, targetDevices)),
    Layer.provide(
      Layer.succeed(ServerSettingsService.ServerSettingsService, sourceSettings.service),
    ),
    Layer.provide(authLayer),
    Layer.provide(secrets.layer),
    Layer.provide(environmentLayer(sourceId)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  );
  const source = yield* DeviceSharing.DeviceSharing.pipe(Effect.provide(sourceLayer));
  const grant = yield* target.createGrant({ sourceEnvironmentId: sourceId, sourceLabel: "Atlas" });
  const connect = source.connect({ label: "Orion", url: "http://orion.test", grant });
  const host = Effect.gen(function* () {
    const config = sourceSettings.read().environmentDeviceHosts[0]!;
    return yield* EnvironmentDeviceHost.make(config);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        secrets.layer,
        environmentLayer(sourceId),
        Layer.succeed(HttpClient.HttpClient, http),
      ),
    ),
  );
  return {
    target,
    source,
    grant,
    grants,
    revoked,
    active,
    targetDevices,
    sourceSettings,
    targetSettings,
    secrets,
    connect,
    host,
    handler,
    http,
    daemonRequests,
    commands,
    setDaemon: (value: DeviceHost.AgentDeviceEndpoint) => {
      daemon = value;
    },
    setUnavailable: (value: boolean) => {
      unavailable = value;
    },
    setInventoryUnavailable: (value: boolean) => {
      inventoryUnavailable = value;
    },
  };
});

it.effect("persists device-only access and reconnects a host without client credentials", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.connect;
    expect(f.grants).toEqual([[AuthDeviceOperateScope]]);
    expect(encodeSettings(f.sourceSettings.read())).not.toContain(f.grant.token);
    expect(f.secrets.entries.size).toBe(1);
    const host = yield* f.host;
    const ready = yield* host.ensureReady(() => Effect.void);
    expect((yield* ready.remote!.list).devices[0]?.hostId).toBe(host.id);
    const resumed = yield* f.host;
    expect((yield* resumed.ensureReady(() => Effect.void)).hub.origin).toBe(
      "http://orion.test/api/device-share/hub",
    );
    yield* f.source.disconnect(host.id);
    expect(f.sourceSettings.read().environmentDeviceHosts).toEqual([]);
    expect(f.secrets.entries.size).toBe(0);
    expect(f.revoked).toContain(f.grant.sessionId);
  }).pipe(Effect.scoped),
);

it.effect(
  "delegates device open and close while isolating matching thread IDs across environments",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.connect;
      const host = yield* f.host;
      const source = yield* DeviceService.makeWithHosts(new Map([[host.id, host]])).pipe(
        Effect.provideService(
          ServerSettingsService.ServerSettingsService,
          f.sourceSettings.service,
        ),
        Effect.provideService(HttpClient.HttpClient, f.http),
      );
      const threadId = ThreadId.make("shared-thread-name");
      yield* f.targetDevices.open({ threadId, deviceId: "emulator-5554", platform: "android" });
      const opened = yield* source.open({
        threadId,
        hostId: host.id,
        deviceId: "emulator-5554",
        platform: "android",
      });
      expect(opened).toMatchObject({
        threadId,
        hostId: host.id,
        deviceId: "emulator-5554",
        platform: "android",
      });
      const targetState = yield* f.targetDevices.state;
      expect(targetState.sessions.map((session) => session.threadId)).toEqual([
        threadId,
        `${EnvironmentDeviceHost.devicePeerThreadPrefix(sourceId)}${threadId}`,
      ]);
      const sourceState = yield* source.state;
      expect(sourceState.externalSessions?.map((session) => session.threadId)).toContain(
        `${EnvironmentDeviceHost.devicePeerThreadPrefix(targetId)}${threadId}`,
      );
      yield* source.close({ threadId, hostId: host.id });
      expect((yield* f.targetDevices.state).sessions.map((session) => session.threadId)).toEqual([
        threadId,
      ]);
    }).pipe(Effect.scoped),
);

it.effect(
  "rejects ordinary credentials, limits requests to the local host, and blocks access when disabled",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.active.set("ordinary", {
        sessionId: AuthSessionId.make("user"),
        subject: "user",
        method: "bearer-access-token",
        scopes: [AuthOrchestrationOperateScope],
      });
      const call = (token: string, body: unknown) =>
        Effect.promise(() =>
          f.handler(
            new Request("http://orion.test/api/device-share/command", {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: encodeJson(body),
            }),
          ),
        );
      expect((yield* call("ordinary", { operation: "list" })).status).toBe(403);
      expect((yield* call(f.grant.token, { operation: "run", command: "whoami" })).status).toBe(
        400,
      );
      const opened = yield* call(f.grant.token, {
        operation: "open",
        input: {
          hostId: "some-other-host",
          threadId: "thread",
          deviceId: "emulator-5554",
          platform: "android",
        },
      });
      expect(opened.status).toBe(200);
      expect(yield* Effect.promise(() => opened.json())).toMatchObject({
        hostId: LOCAL_DEVICE_HOST_ID,
      });
      yield* f.targetDevices.configure({ agentAccessEnabled: false });
      const disabled = yield* call(f.grant.token, { operation: "list" });
      expect(disabled.status).toBe(422);
      expect(yield* Effect.promise(() => disabled.json())).toMatchObject({
        error: {
          _tag: "DeviceHostUnavailableError",
          reason: expect.stringContaining("Enable device hub"),
        },
      });
      expect((yield* call(f.grant.token, { operation: "revoke" })).status).toBe(200);
      expect((yield* f.targetDevices.state).sessions).toEqual([]);
      expect((yield* call(f.grant.token, { operation: "list" })).status).toBe(401);
    }).pipe(Effect.scoped),
);

it.effect(
  "proxies agent routes with a separate credential that stops when agent access stops",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.connect;
      const host = yield* f.host;
      const ready = yield* host.ensureAgentReady(() => Effect.void);
      expect(ready.agentDevice.baseUrl).toBe("http://orion.test/api/device-share/agent");
      expect(ready.agentDevice.token).not.toBe(f.grant.token);
      const agentToken = ready.agentDevice.token;
      const call = (path: string, token: string, init: RequestInit = {}) =>
        Effect.promise(() =>
          f.handler(
            new Request(`http://orion.test/api/device-share/${path}`, {
              ...init,
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                ...init.headers,
              },
            }),
          ),
        );
      const response = yield* call("agent/health", agentToken, {
        headers: { "x-agent-device-token": "must-not-forward" },
      });
      expect(response.status).toBe(200);
      yield* Effect.promise(() => response.text());
      expect(f.daemonRequests[0]?.headers.authorization).toBe("Bearer synthetic-daemon-token");
      expect(f.daemonRequests[0]?.headers["x-agent-device-token"]).toBe("synthetic-daemon-token");
      expect(f.daemonRequests[0]?.headers["x-agent-device-network-access"]).toBe("public-only");
      // The grant does not reach the agent proxy, and the agent credential cannot issue
      // peer commands such as re-enabling itself.
      expect((yield* call("agent/health", f.grant.token)).status).toBe(401);
      const command = yield* call("command", agentToken, {
        method: "POST",
        body: encodeJson({ operation: "agent" }),
      });
      expect(command.status).toBe(401);
      expect((yield* call("agent/shutdown", agentToken)).status).toBe(404);
      // Preflight responses carry the daemon credential, so direct uploads stay local.
      expect(
        (yield* call("agent/upload/preflight", agentToken, { method: "POST", body: "{}" })).status,
      ).toBe(404);
      expect(
        (yield* call("agent/admin/human-control/holds/device", agentToken, { method: "PUT" }))
          .status,
      ).toBe(404);
      const rpc = yield* call("agent/rpc", agentToken, {
        method: "POST",
        body: encodeJson({
          jsonrpc: "2.0",
          id: 1,
          method: "agent_device.command",
          params: { token: agentToken, command: "session_list" },
        }),
      });
      expect(rpc.status).toBe(200);
      yield* Effect.promise(() => rpc.text());
      expect(f.daemonRequests[1]?.body).not.toContain(agentToken);
      expect(f.daemonRequests[1]?.body).toContain('"command":"session_list"');
      expect(f.daemonRequests[1]?.headers.authorization).toBe("Bearer synthetic-daemon-token");
      expect(f.daemonRequests).toHaveLength(2);

      yield* host.stopAgent;
      expect((yield* call("agent/health", agentToken)).status).toBe(401);
      const renewed = yield* host.ensureAgentReady(() => Effect.void);
      const renewedResponse = yield* call("agent/health", renewed.agentDevice.token);
      expect(renewedResponse.status).toBe(200);
      yield* Effect.promise(() => renewedResponse.text());
    }).pipe(Effect.scoped),
);

it.effect("stops forwarding agent requests after the grant is revoked in Connections", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const agent = yield* f.target.command(
      { subject: `device-host:${sourceId}`, sessionId: f.grant.sessionId },
      { operation: "agent" },
    );
    const { token } = decodePeerAgent(agent);
    expect(yield* f.target.agentTarget(token)).not.toBeNull();
    // Connections settings revoke the session without telling the sharing service.
    f.active.delete(f.grant.token);
    yield* TestClock.adjust("31 seconds");
    expect(yield* f.target.agentTarget(token)).toBeNull();
  }).pipe(Effect.scoped),
);

it.effect("reports the device environment's own error with this host's ID", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.connect;
    const host = yield* f.host;
    const ready = yield* host.ensureReady(() => Effect.void);
    const missing = yield* ready
      .remote!.open({
        threadId: ThreadId.make("thread"),
        deviceId: "emulator-0000",
        platform: "android",
      })
      .pipe(Effect.flip);
    expect(missing).toBeInstanceOf(DeviceNotFoundError);
    expect(missing).toMatchObject({ hostId: host.id, deviceId: "emulator-0000" });

    f.active.delete(f.grant.token);
    const expired = yield* ready.remote!.list.pipe(Effect.flip);
    expect(expired).toMatchObject({
      _tag: "DeviceHostUnavailableError",
      hostId: host.id,
      reason: "Device access expired or was revoked. Reconnect the environment.",
    });
  }).pipe(Effect.scoped),
);

it.effect("closes the local session when the device environment is unreachable", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.connect;
    const host = yield* f.host;
    const source = yield* DeviceService.makeWithHosts(new Map([[host.id, host]])).pipe(
      Effect.provideService(ServerSettingsService.ServerSettingsService, f.sourceSettings.service),
      Effect.provideService(HttpClient.HttpClient, f.http),
    );
    const threadId = ThreadId.make("thread");
    yield* source.open({
      threadId,
      hostId: host.id,
      deviceId: "emulator-5554",
      platform: "android",
    });
    f.setUnavailable(true);
    yield* source.close({ threadId, hostId: host.id });
    expect((yield* source.state).sessions).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("retries stopping agent access until the device environment is reachable", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.connect;
    const host = yield* f.host;
    const { agentDevice } = yield* host.ensureAgentReady(() => Effect.void);
    const health = Effect.promise(() =>
      f.handler(
        new Request("http://orion.test/api/device-share/agent/health", {
          headers: { authorization: `Bearer ${agentDevice.token}` },
        }),
      ),
    );
    f.setUnavailable(true);
    yield* host.stopAgent;
    f.setUnavailable(false);
    const allowed = yield* health;
    expect(allowed.status).toBe(200);
    yield* Effect.promise(() => allowed.text());
    yield* TestClock.adjust("31 seconds");
    while ((yield* Queue.take(f.commands)) !== "stop-agent:200");
    expect((yield* health).status).toBe(401);
  }).pipe(Effect.scoped),
);

it.effect("forwards agent requests to the device environment's current daemon", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const session = { subject: `device-host:${sourceId}`, sessionId: f.grant.sessionId };
    const issued = decodePeerAgent(yield* f.target.command(session, { operation: "agent" }));
    expect((yield* f.target.agentTarget(issued.token))?.origin).toBe("http://daemon.test");
    // Turning agent access off and on restarts the daemon with a new port and token.
    f.setDaemon({ baseUrl: "http://daemon-restarted.test", token: "restarted", entryPath: "" });
    expect(yield* f.target.agentTarget(issued.token)).toMatchObject({
      origin: "http://daemon-restarted.test",
      headers: { authorization: "Bearer restarted" },
    });
    yield* f.targetSettings.service.updateSettings({ enableAgentDeviceAccess: false });
    expect(yield* f.target.agentTarget(issued.token).pipe(Effect.flip)).toMatchObject({
      reason: expect.stringContaining("Enable device hub"),
    });
    yield* f.targetSettings.service.updateSettings({ enableAgentDeviceAccess: true });
    expect(yield* f.target.agentTarget(issued.token)).toBeNull();
  }).pipe(Effect.scoped),
);

it.effect("rejects a mismatched environment identity without storing access", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const result = yield* f.source
      .connect({
        label: "Wrong server",
        url: "http://orion.test",
        grant: { ...f.grant, environmentId: EnvironmentId.make("another-environment") },
      })
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(f.sourceSettings.read().environmentDeviceHosts).toEqual([]);
    expect(f.secrets.entries.size).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("removes a host after its grant was revoked on the target", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.connect;
    f.active.delete(f.grant.token);
    yield* f.source.disconnect(f.sourceSettings.read().environmentDeviceHosts[0]!.id);
    expect(f.sourceSettings.read().environmentDeviceHosts).toEqual([]);
    expect(f.secrets.entries.size).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("checks the credential's source identity before persisting access", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const grant = yield* f.target.createGrant({
      sourceEnvironmentId: EnvironmentId.make("another-source"),
      sourceLabel: "Another source",
    });
    const result = yield* f.source
      .connect({
        label: "Orion",
        url: "http://orion.test",
        grant: { ...grant, sourceEnvironmentId: sourceId },
      })
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(f.sourceSettings.read().environmentDeviceHosts).toEqual([]);
    expect(f.secrets.entries.size).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("does not replace an SSH host with a colliding ID", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const host = {
      id: EnvironmentDeviceHost.environmentDeviceHostId(targetId),
      label: "SSH device host",
      target: "device.test",
    };
    yield* f.sourceSettings.service.updateSettings({ deviceHosts: [host] });
    const result = yield* f.connect.pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(f.sourceSettings.read().deviceHosts).toEqual([host]);
    expect(f.sourceSettings.read().environmentDeviceHosts).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("establishes access without requiring device inventory to be available", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.setInventoryUnavailable(true);
    yield* f.connect;
    expect(f.sourceSettings.read().environmentDeviceHosts).toHaveLength(1);
    const host = yield* f.host;
    const ready = yield* host.ensureReady(() => Effect.void);
    const listed = yield* ready.remote!.list.pipe(Effect.result);
    expect(listed._tag).toBe("Failure");
    f.setInventoryUnavailable(false);
    expect((yield* (yield* host.ensureReady(() => Effect.void)).remote!.list).devices).toHaveLength(
      1,
    );
  }).pipe(Effect.scoped),
);

it.effect("reconnecting replaces the credential and revokes the previous grant", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.connect;
    const grant = yield* f.target.createGrant({
      sourceEnvironmentId: sourceId,
      sourceLabel: "Atlas",
    });
    yield* f.source.connect({ label: "Orion", url: "http://orion.test", grant });
    expect(f.sourceSettings.read().environmentDeviceHosts).toHaveLength(1);
    expect(f.sourceSettings.read().environmentDeviceHosts[0]?.sessionId).toBe(grant.sessionId);
    expect(f.active.has(f.grant.token)).toBe(false);
    expect(f.active.has(grant.token)).toBe(true);
    const host = yield* f.host;
    expect((yield* (yield* host.ensureReady(() => Effect.void)).remote!.list).devices).toHaveLength(
      1,
    );
  }).pipe(Effect.scoped),
);

it.effect("restores the previous credential if saving a replacement fails", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.connect;
    const original = f.sourceSettings.read().environmentDeviceHosts[0]!;
    const grant = yield* f.target.createGrant({
      sourceEnvironmentId: sourceId,
      sourceLabel: "Atlas",
    });
    f.sourceSettings.failWrites(true);
    const result = yield* f.source
      .connect({ label: "Replacement", url: "http://orion.test", grant })
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(f.sourceSettings.read().environmentDeviceHosts).toEqual([original]);
    const host = yield* f.host;
    yield* host.ensureReady(() => Effect.void);
    expect(f.active.has(f.grant.token)).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect(
  "removes unavailable hosts locally and reports that remote revocation remains necessary",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.connect;
      f.setUnavailable(true);
      const result = yield* f.source
        .disconnect(f.sourceSettings.read().environmentDeviceHosts[0]!.id)
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          reason: expect.stringContaining("removed locally"),
        });
      expect(f.sourceSettings.read().environmentDeviceHosts).toEqual([]);
      expect(f.secrets.entries.size).toBe(0);
      expect(f.active.has(f.grant.token)).toBe(true);
    }).pipe(Effect.scoped),
);

it.effect(
  "keeps driver sessions distinct for two source environments using the same thread and device",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.connect;
      const firstHost = yield* f.host;
      const config = f.sourceSettings.read().environmentDeviceHosts[0]!;
      const otherId = EnvironmentId.make("another-source");
      const otherGrant = yield* f.target.createGrant({
        sourceEnvironmentId: otherId,
        sourceLabel: "Other source",
      });
      f.secrets.entries.set(
        EnvironmentDeviceHost.environmentDeviceHostSecret(config.id),
        new TextEncoder().encode(otherGrant.token),
      );
      const secondHost = yield* EnvironmentDeviceHost.make(config).pipe(
        Effect.provide(
          Layer.mergeAll(
            f.secrets.layer,
            environmentLayer(otherId),
            Layer.succeed(HttpClient.HttpClient, f.http),
          ),
        ),
      );
      const service = (host: DeviceHost.DeviceHost["Service"]) =>
        DeviceService.makeWithHosts(new Map([[host.id, host]]), undefined, () =>
          Effect.succeed("/synthetic/driver.json"),
        ).pipe(
          Effect.provideService(
            ServerSettingsService.ServerSettingsService,
            f.sourceSettings.service,
          ),
          Effect.provideService(HttpClient.HttpClient, f.http),
        );
      const first = yield* service(firstHost);
      const second = yield* service(secondHost);
      const input = {
        hostId: config.id,
        threadId: ThreadId.make("same-thread"),
        deviceId: "emulator-5554",
      };
      const firstArgs = yield* first.agentTarget(input);
      const secondArgs = yield* second.agentTarget(input);
      expect(firstArgs).not.toEqual(secondArgs);
      expect(yield* first.agentTarget(input)).toEqual(firstArgs);
    }).pipe(Effect.scoped),
);
