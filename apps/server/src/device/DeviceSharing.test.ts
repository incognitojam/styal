import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { it, expect } from "@effect/vitest";
import {
  AuthDeviceOperateScope,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  DEFAULT_SERVER_SETTINGS,
  DeviceNotFoundError,
  DeviceSession,
  DeviceToolListResult,
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
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse, HttpRouter } from "effect/http";
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
    updateProviderInstance: () => Effect.die(new Error("Provider instances are unused here.")),
    withSettingsSnapshot: (use) => Effect.suspend(() => use(value)),
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
  const addressFailures = new Map<string, string>();
  const probeStarted = yield* Deferred.make<void>();
  const peerRequests: { origin: string; operation: string }[] = [];
  let loseOpenResponse = false;
  let legacyPeer = false;
  // Peer commands the target finished handling, as "operation:status".
  const commands = yield* Queue.unbounded<string>();
  let inventoryUnavailable = false;
  let memoryDevice = false;
  let rejectMemoryOpen = false;
  let memoryBooted = false;
  let memoryDisabled = 153;
  const memoryCommands: string[] = [];
  const memoryCapabilities = [
    "push",
    "storekit",
    "universal-links",
    "icloud",
    "keychain-sync",
    "photos",
    "contacts",
    "calendar",
  ];
  // Hub device streams and daemon artifact downloads stay open until the test closes them.
  const openStreams: ReadableStreamDefaultController<Uint8Array>[] = [];
  let readyGate: Deferred.Deferred<void> | null = null;
  const readyStarted = yield* Deferred.make<void>();
  let handler: (request: Request) => Promise<Response>;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (
        ["http://orion.test", "https://orion-alt.test", "http://unreachable.test"].includes(
          new URL(request.url).origin,
        )
      ) {
        const origin = new URL(request.url).origin;
        const body =
          request.body._tag === "Uint8Array"
            ? new TextDecoder().decode(request.body.body)
            : undefined;
        const operation =
          request.url.endsWith("/api/device-share/command") && body
            ? decodeCommandBody(body).operation
            : "proxy";
        peerRequests.push({ origin, operation });
        if (rejectMemoryOpen && operation === "open-low-memory")
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 400 }));
        const code = addressFailures.get(origin);
        if (code === "timeout") {
          yield* Deferred.succeed(probeStarted, undefined);
          return yield* Effect.never;
        }
        if (code)
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: { cause: { code } } }),
          });
        if (unavailable)
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }));
        if (legacyPeer && operation === "identify")
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 400 }));
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
        if (loseOpenResponse && operation === "open") {
          loseOpenResponse = false;
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: { code: "ECONNRESET" } }),
          });
        }
        return HttpClientResponse.fromWeb(request, response);
      }
      if (request.url.endsWith("/stream.mjpeg") || request.url.includes("/artifacts/"))
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream<Uint8Array>({
              start: (controller) => {
                openStreams.push(controller);
                controller.enqueue(new TextEncoder().encode("chunk"));
              },
            }),
          ),
        );
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
      if (memoryDevice && request.url.endsWith("/shutdown")) memoryBooted = false;
      if (memoryDevice && request.url.endsWith("/boot")) memoryBooted = true;
      const response =
        memoryDevice && new URL(request.url).pathname === "/api/devices"
          ? {
              simulators: [
                {
                  id: "emulator-5554",
                  platform: "ios",
                  name: "Test iPhone",
                  booted: memoryBooted,
                  physical: false,
                  version: "26.5",
                },
              ],
              emulators: [],
            }
          : new URL(request.url).pathname === "/api/devices"
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
get devices() {
      return makeDeviceHubOperations({ hostId: LOCAL_DEVICE_HOST_ID, origin: ready.hub.origin, http: http, run: ready.run, androidAvailable: Effect.succeed(true) });
    },
    nodePath: process.execPath,
    hub: { origin: "http://hub.test" },
    helpers: { serveSimCli: null, serveSimAxSettings: null },
    run: (command, commandArgs) =>
      Effect.sync(() => {
        const json = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
        if (!memoryDevice)
          return { stdout: command === "emulator" ? "" : " V....D libx264", stderr: "", code: 0 };
        if (command === process.execPath)
          return json({ supported: true, installed: true, executable: "/simslim" });
        // Mutations pass SimSlim's global boot limit first.
        const args = commandArgs[0] === "--boot-timeout" ? commandArgs.slice(2) : commandArgs;
        if (command !== "/simslim") return { stdout: "", stderr: "", code: 0 };
        if (args[0] === "status")
          return json({ persistent: true, managedDisabled: memoryDisabled });
        if (args.includes("--list"))
          return json(memoryCapabilities.map((id) => ({ id, labels: [`com.apple.test.${id}`] })));
        if (args[0] === "doctor")
          return json({ features: memoryCapabilities.map((id) => ({ id, ok: true })) });
        memoryCommands.push(args[0]!);
        memoryBooted = true;
        memoryDisabled = args[0] === "on" ? 153 : 0;
        return { stdout: "", stderr: "", code: 0 };
      }),
    agentDevice: {
      baseUrl: "http://daemon.test",
      token: "synthetic-daemon-token",
      entryPath: "/driver",
    },
  };
  const local = DeviceHost.DeviceHost.of({
    id: LOCAL_DEVICE_HOST_ID,
    summary: Effect.sync(() => ({
      id: LOCAL_DEVICE_HOST_ID,
      kind: "local",
      label: "Orion",
      platforms: [{ platform: memoryDevice ? "ios" : "android", available: true }],
      hubInstalled: true,
      agentDeviceInstalled: true,
    })),
    platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
    ensureReady: () =>
      Effect.suspend(() =>
        readyGate
          ? Deferred.succeed(readyStarted, undefined).pipe(
              Effect.andThen(Deferred.await(readyGate)),
            )
          : Effect.void,
      ).pipe(Effect.as(ready)),
    ensureAgentReady: () => Effect.succeed(ready),
    current: Effect.succeed(ready),
    currentAgent: Effect.sync(() => daemon),
    stopAgent: Effect.void,
    stop: Effect.void,
  });
  const targetDevices = yield* DeviceService.makeWithHosts(new Map([[local.id, local]])).pipe(
    Effect.provide(NodeCrypto.layer),
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
    ).pipe(
      // The routes share `target`'s in-memory state, as they do in the server.
      Layer.provideMerge(Layer.succeed(DeviceSharing.DeviceSharing, target)),
      Layer.provideMerge(targetLayer),
    ),
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
  const connect = source.connect({ label: "Orion", urls: ["http://orion.test"], grant });
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
    useMemoryDevice: () => {
      memoryDevice = true;
    },
    rejectMemoryOpen: () => {
      rejectMemoryOpen = true;
    },
    memoryCommands,
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
    peerRequests,
    addressFailures,
    probeStarted,
    setLegacyPeer: () => {
      legacyPeer = true;
    },
    loseNextOpenResponse: () => {
      loseOpenResponse = true;
    },
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
    openStreams,
    readyStarted,
    setReadyGate: (gate: Deferred.Deferred<void> | null) => {
      readyGate = gate;
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

it.effect("prepares and restores a cold iOS simulator on the owning environment", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.useMemoryDevice();
    yield* f.connect;
    const host = yield* f.host;
    const ready = yield* host.ensureReady(() => Effect.void);
    const input = {
      threadId: ThreadId.make("memory-project"),
      deviceId: "emulator-5554",
      platform: "ios" as const,
    };
    yield* ready.remote!.open(input, "low-memory");
    expect(f.memoryCommands).toEqual(["on"]);
    expect(f.peerRequests.some((request) => request.operation === "open-low-memory")).toBe(true);
    yield* ready.remote!.close({ ...input, shutdown: true });
    yield* ready.remote!.open(input, "standard");
    expect(f.memoryCommands).toEqual(["on", "off"]);
  }).pipe(Effect.scoped),
);

it.effect("opens normally with a notice when an older peer rejects Low memory", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.useMemoryDevice();
    f.rejectMemoryOpen();
    yield* f.connect;
    const ready = yield* (yield* f.host).ensureReady(() => Effect.void);
    const session = yield* ready.remote!.open(
      { threadId: ThreadId.make("memory-project"), deviceId: "emulator-5554", platform: "ios" },
      "low-memory",
    );
    expect(session.notice).toContain("older styal without Low memory");
    expect(f.memoryCommands).not.toContain("on");
    expect(
      f.peerRequests
        .filter((request) => request.operation.startsWith("open"))
        .map((request) => request.operation),
    ).toEqual(["open-low-memory", "open"]);
  }).pipe(Effect.scoped),
);

it.effect.each(["enableDeviceSupport", "enableAgentDeviceAccess"] as const)(
  "revokes a saved share after %s is disabled",
  (setting) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.connect;
      const host = f.sourceSettings.read().environmentDeviceHosts[0]!;
      yield* f.targetSettings.service.updateSettings({ [setting]: false });
      yield* f.source.disconnect(host.id);
      expect(f.active.has(f.grant.token)).toBe(false);
      expect(f.sourceSettings.read().environmentDeviceHosts).toEqual([]);
      expect(f.peerRequests.slice(-2).map((entry) => entry.operation)).toEqual([
        "identify",
        "revoke",
      ]);
    }).pipe(Effect.scoped),
);

it.effect("stops an agent after a failed request and disabled device access", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.source.connect({
      label: "Orion",
      urls: ["http://orion.test", "https://orion-alt.test"],
      grant: f.grant,
    });
    const host = yield* f.host;
    const ready = yield* host.ensureAgentReady(() => Effect.void);
    f.addressFailures.set("http://orion.test", "ECONNRESET");
    yield* ready.remote!.close({ threadId: ThreadId.make("synthetic-thread") }).pipe(Effect.result);
    f.addressFailures.clear();
    yield* f.targetSettings.service.updateSettings({ enableAgentDeviceAccess: false });
    yield* host.stopAgent;
    yield* f.targetSettings.service.updateSettings({ enableAgentDeviceAccess: true });
    const response = yield* Effect.promise(() =>
      f.handler(
        new Request("http://orion.test/api/device-share/agent/health", {
          headers: { authorization: `Bearer ${ready.agentDevice!.token}` },
        }),
      ),
    );
    expect(response.status).toBe(401);
  }).pipe(Effect.scoped),
);

it.effect("releases sessions through an alternative address while device access is off", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.source.connect({
      label: "Orion",
      urls: ["http://orion.test", "https://orion-alt.test"],
      grant: f.grant,
    });
    const host = yield* f.host;
    const ready = yield* host.ensureReady(() => Effect.void);
    yield* ready.remote!.open({
      threadId: ThreadId.make("cleanup-thread"),
      deviceId: "emulator-5554",
      platform: "android",
    });
    f.addressFailures.set("http://orion.test", "ECONNREFUSED");
    yield* f.targetSettings.service.updateSettings({ enableDeviceSupport: false });
    yield* host.stop;
    expect((yield* f.targetDevices.state).sessions).toEqual([]);
    expect(f.active.has(f.grant.token)).toBe(true);
    expect(f.peerRequests).toContainEqual({
      origin: "https://orion-alt.test",
      operation: "release",
    });
  }).pipe(Effect.scoped),
);

it.effect("checks both peer identities before sending cleanup commands", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.connect;
    const config = f.sourceSettings.read().environmentDeviceHosts[0]!;
    for (const identity of [
      { environmentId: "another-target", sourceEnvironmentId: sourceId },
      { environmentId: targetId, sourceEnvironmentId: "another-source" },
    ]) {
      const operations: string[] = [];
      const http = HttpClient.make((request) => {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        operations.push(decodeCommandBody(body).operation);
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(identity)));
      });
      const client = yield* EnvironmentDeviceHost.makeClient(config, f.grant.token, sourceId).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const error = yield* client.request({ operation: "revoke" }, Schema.Null).pipe(Effect.flip);
      expect(error).toMatchObject({ reason: expect.stringContaining("different environment") });
      expect(operations).toEqual(["identify"]);
      expect(f.active.has(f.grant.token)).toBe(true);
    }
  }).pipe(Effect.scoped),
);

it.effect("can clean up older peers that expose identity through inspect", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.connect;
    const config = f.sourceSettings.read().environmentDeviceHosts[0]!;
    const http = HttpClient.make((request) => {
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      return decodeCommandBody(body).operation === "identify"
        ? Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 400 })))
        : f.http.execute(request);
    });
    const client = yield* EnvironmentDeviceHost.makeClient(config, f.grant.token, sourceId).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    yield* client.request({ operation: "revoke" }, Schema.Null);
    expect(f.active.has(f.grant.token)).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect(
  "requires identity verification for an older peer at an unverified alternative address",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.source.connect({
        label: "Orion",
        urls: ["http://orion.test", "https://orion-alt.test"],
        grant: f.grant,
      });
      const config = f.sourceSettings.read().environmentDeviceHosts[0]!;
      f.addressFailures.set(config.url, "ECONNREFUSED");
      f.setLegacyPeer();
      yield* f.targetSettings.service.updateSettings({ enableDeviceSupport: false });
      const client = yield* EnvironmentDeviceHost.makeClient(config, f.grant.token, sourceId).pipe(
        Effect.provideService(HttpClient.HttpClient, f.http),
      );
      const result = yield* client
        .request({ operation: "revoke" }, Schema.Null)
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(f.active.has(f.grant.token)).toBe(true);
      expect(f.peerRequests).not.toContainEqual({
        origin: "https://orion-alt.test",
        operation: "revoke",
      });
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
        Effect.provide(NodeCrypto.layer),
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
      // agent-device streams uploads with chunked transfer encoding.
      const upload = yield* call("agent/upload", agentToken, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "transfer-encoding": "chunked" },
        body: "synthetic artifact",
      });
      expect(upload.status).toBe(200);
      yield* Effect.promise(() => upload.text());
      expect(f.daemonRequests[2]?.url).toBe("http://daemon.test/upload");
      expect(f.daemonRequests[2]?.headers["transfer-encoding"]).toBeUndefined();
      expect(f.daemonRequests).toHaveLength(3);

      yield* host.stopAgent;
      expect((yield* call("agent/health", agentToken)).status).toBe(401);
      // agent-device only shows a rejected RPC's message when it is a JSON-RPC error.
      const rejected = yield* call("agent/rpc", agentToken, {
        method: "POST",
        body: encodeJson({ jsonrpc: "2.0", id: 2, method: "agent_device.command", params: {} }),
      });
      expect(rejected.status).toBe(401);
      expect(yield* Effect.promise(() => rejected.json())).toMatchObject({
        jsonrpc: "2.0",
        error: { code: -32001, message: expect.stringContaining("device_open") },
      });
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
      Effect.provide(NodeCrypto.layer),
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

const encodeToolListResult = Schema.encodeSync(DeviceToolListResult);
// MCP structured content must be a JSON object, which rejects keys set to undefined.
const isJsonObject = Schema.is(Schema.JsonObject);

it.effect("lists an unreachable device environment as JSON that MCP tool results accept", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.connect;
    f.setUnavailable(true);
    const host = yield* f.host;
    const source = yield* DeviceService.makeWithHosts(new Map([[host.id, host]])).pipe(
      Effect.provide(NodeCrypto.layer),
      Effect.provideService(ServerSettingsService.ServerSettingsService, f.sourceSettings.service),
      Effect.provideService(HttpClient.HttpClient, f.http),
    );
    const state = yield* source.list;
    expect(state.hostStatuses[host.id]?.status).toBe("failed");
    const encoded = encodeToolListResult({
      hostStatuses: state.hostStatuses,
      hosts: state.hosts,
      devices: state.devices,
      open: [],
      openInOtherThreads: [],
    });
    expect(isJsonObject(encoded)).toBe(true);
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

it.effect("explains loopback addresses when the device environment cannot be reached", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const failure = yield* f.source
      .connect({ label: "Orion", urls: ["http://127.0.0.1:3773"], grant: f.grant })
      .pipe(Effect.flip);
    expect(failure).toMatchObject({
      _tag: "DeviceHostUnavailableError",
      reason: expect.stringContaining("Loopback addresses only work"),
    });
    expect(f.sourceSettings.read().environmentDeviceHosts).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("rejects a mismatched environment identity without storing access", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const result = yield* f.source
      .connect({
        label: "Wrong server",
        urls: ["http://orion.test"],
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
        urls: ["http://orion.test"],
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
    yield* f.source.connect({ label: "Orion", urls: ["http://orion.test"], grant });
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
      .connect({ label: "Replacement", urls: ["http://orion.test"], grant })
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
          Effect.provide(NodeCrypto.layer),
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

it.effect("tries alternate addresses before saving a grant and retains them across restart", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.addressFailures.set("http://unreachable.test", "ECONNREFUSED");
    yield* f.source.connect({
      label: "Orion",
      urls: ["http://unreachable.test/", "https://orion-alt.test/", "https://orion-alt.test"],
      grant: f.grant,
    });
    const saved = f.sourceSettings.read().environmentDeviceHosts[0]!;
    expect(saved).toMatchObject({
      url: "https://orion-alt.test",
      urls: ["http://unreachable.test", "https://orion-alt.test"],
    });
    expect(f.peerRequests).toEqual([
      { origin: "http://unreachable.test", operation: "inspect" },
      { origin: "https://orion-alt.test", operation: "inspect" },
    ]);
    const resumed = yield* f.host;
    expect(
      (yield* (yield* resumed.ensureReady(() => Effect.void)).remote!.list).devices,
    ).toHaveLength(1);
    expect((yield* resumed.summary).connectedUrl).toBe("https://orion-alt.test");
  }).pipe(Effect.scoped),
);

it.effect(
  "reads through another saved address after the current one stops answering, without a new grant",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.source.connect({
        label: "Orion",
        urls: ["http://orion.test", "https://orion-alt.test"],
        grant: f.grant,
      });
      const host = yield* f.host;
      const ready = yield* host.ensureReady(() => Effect.void);
      f.addressFailures.set("http://orion.test", "ECONNREFUSED");
      expect((yield* ready.remote!.list).devices).toHaveLength(1);
      // New streams follow the selected address.
      expect(ready.hub.origin).toBe("https://orion-alt.test/api/device-share/hub");
      expect((yield* host.summary).connectedUrl).toBe("https://orion-alt.test");
      expect(f.grants).toHaveLength(1);
      yield* f.source.disconnect(host.id);
      expect(f.active.has(f.grant.token)).toBe(false);
    }).pipe(Effect.scoped),
);

it.effect(
  "does not replay an open operation after the target ran it but its response was lost",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.source.connect({
        label: "Orion",
        urls: ["http://orion.test", "https://orion-alt.test"],
        grant: f.grant,
      });
      const config = f.sourceSettings.read().environmentDeviceHosts[0]!;
      const client = yield* EnvironmentDeviceHost.makeClient(config, f.grant.token, sourceId).pipe(
        Effect.provideService(HttpClient.HttpClient, f.http),
      );
      yield* client.info("inspect");
      f.loseNextOpenResponse();
      const opened = yield* client
        .request(
          {
            operation: "open",
            input: {
              threadId: ThreadId.make("lost-response"),
              deviceId: "emulator-5554",
              platform: "android",
            },
          },
          DeviceSession,
        )
        .pipe(Effect.result);
      expect(opened._tag).toBe("Failure");
      expect(f.peerRequests.filter((request) => request.operation === "open")).toHaveLength(1);
      expect((yield* f.targetDevices.state).sessions).toHaveLength(1);
      f.addressFailures.set("http://orion.test", "ECONNREFUSED");
      expect((yield* client.info("list")).devices).toHaveLength(1);
      expect(client.baseUrl).toBe("https://orion-alt.test");
    }).pipe(Effect.scoped),
);

it.effect(
  "keeps typed peer failures and revoked access from replaying actions on another address",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.source.connect({
        label: "Orion",
        urls: ["http://orion.test", "https://orion-alt.test"],
        grant: f.grant,
      });
      const host = yield* f.host;
      const ready = yield* host.ensureReady(() => Effect.void);
      const close = { threadId: ThreadId.make("missing-device"), deviceId: "missing" };
      const failure = yield* ready.remote!.detail({ deviceId: "missing" }).pipe(Effect.flip);
      expect(failure._tag).toBe("DeviceNotFoundError");
      expect(
        f.peerRequests.filter((request) => request.origin === "https://orion-alt.test"),
      ).toHaveLength(0);
      f.active.delete(f.grant.token);
      const revoked = yield* ready.remote!.close(close).pipe(Effect.flip);
      expect(revoked).toMatchObject({
        _tag: "DeviceHostUnavailableError",
        reason: expect.stringContaining("revoked"),
      });
      expect(f.peerRequests.filter((request) => request.operation === "close")).toHaveLength(1);
      expect(f.grants).toHaveLength(1);
    }).pipe(Effect.scoped),
);

it.effect("bounds address probes so a silent LAN address cannot block a working alternative", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.addressFailures.set("http://unreachable.test", "timeout");
    const connecting = yield* f.source
      .connect({
        label: "Orion",
        urls: ["http://unreachable.test", "https://orion-alt.test"],
        grant: f.grant,
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(f.probeStarted);
    yield* TestClock.adjust("3 seconds");
    yield* Fiber.join(connecting);
    expect(f.sourceSettings.read().environmentDeviceHosts[0]?.url).toBe("https://orion-alt.test");
  }).pipe(Effect.scoped),
);

it.effect(
  "skips a responding address with the wrong identity before sending any device operation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const wrongRequests: string[] = [];
      const http = HttpClient.make((request) => {
        if (!request.url.startsWith("http://wrong.test")) return f.http.execute(request);
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        wrongRequests.push(decodeCommandBody(body).operation);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              environmentId: "another-environment",
              sourceEnvironmentId: sourceId,
              host: {
                id: "local",
                kind: "local",
                label: "Other environment",
                platforms: [],
                hubInstalled: false,
                agentDeviceInstalled: false,
              },
              devices: [],
              sessions: [],
            }),
          ),
        );
      });
      const client = yield* EnvironmentDeviceHost.makeClient(
        {
          id: EnvironmentDeviceHost.environmentDeviceHostId(targetId),
          label: "Orion",
          environmentId: targetId,
          url: "http://wrong.test",
          urls: ["http://wrong.test", "https://orion-alt.test"],
          sessionId: f.grant.sessionId,
        },
        f.grant.token,
        sourceId,
      ).pipe(Effect.provideService(HttpClient.HttpClient, http));
      expect((yield* client.info("list")).devices).toHaveLength(1);
      expect(client.baseUrl).toBe("https://orion-alt.test");
      expect(wrongRequests).toEqual(["inspect"]);
    }).pipe(Effect.scoped),
);

it.effect("counts another environment as using devices only while it uses them", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const peer = { subject: `device-host:${sourceId}`, sessionId: f.grant.sessionId };
    const target = { deviceId: "emulator-5554", platform: "android" as const };
    yield* f.target.command(peer, {
      operation: "open",
      input: { threadId: ThreadId.make("thread"), hostId: LOCAL_DEVICE_HOST_ID, ...target },
    });
    expect(yield* f.target.environmentsUsingDevices).toBe(1);
    // An agent between device actions still holds the device.
    yield* TestClock.adjust("4 minutes");
    expect(yield* f.target.environmentsUsingDevices).toBe(1);
    // A session left open after the work ended does not block a restart.
    yield* TestClock.adjust("2 minutes");
    expect(yield* f.target.environmentsUsingDevices).toBe(0);
    // Discovery is not use.
    yield* f.target.command(peer, { operation: "list" });
    expect(yield* f.target.environmentsUsingDevices).toBe(0);
    yield* f.target.command(peer, {
      operation: "detail",
      input: { hostId: LOCAL_DEVICE_HOST_ID, ...target },
    });
    expect(yield* f.target.environmentsUsingDevices).toBe(1);
    yield* f.target.command(peer, { operation: "release" });
    expect(yield* f.target.environmentsUsingDevices).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("does not count a person watching a shared device", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const response = yield* Effect.promise(() =>
      f.handler(
        new Request(
          "http://orion.test/api/device-share/hub/vendor/serve-sim/helper/sim/stream.mjpeg",
          { headers: { authorization: `Bearer ${f.grant.token}` } },
        ),
      ),
    );
    expect(response.status).toBe(200);
    yield* TestClock.adjust("1 hour");
    expect(yield* f.target.environmentsUsingDevices).toBe(0);
    yield* Effect.promise(() => response.body!.cancel());
  }).pipe(Effect.scoped),
);

it.effect("counts a device command while it is still running", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const peer = { subject: `device-host:${sourceId}`, sessionId: f.grant.sessionId };
    const gate = yield* Deferred.make<void>();
    f.setReadyGate(gate);
    // A cold open can take minutes before the device session exists.
    const open = yield* f.target
      .command(peer, {
        operation: "open",
        input: {
          threadId: ThreadId.make("thread"),
          hostId: LOCAL_DEVICE_HOST_ID,
          deviceId: "emulator-5554",
          platform: "android",
        },
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(f.readyStarted);
    yield* TestClock.adjust("10 minutes");
    expect(yield* f.target.environmentsUsingDevices).toBe(1);
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(open);
    expect(yield* f.target.environmentsUsingDevices).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("counts an agent request for as long as it stays open", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.connect;
    const host = yield* f.host;
    yield* (yield* host.ensureReady(() => Effect.void)).remote!.open({
      threadId: ThreadId.make("thread"),
      deviceId: "emulator-5554",
      platform: "android",
    });
    const { agentDevice } = yield* host.ensureAgentReady(() => Effect.void);
    const download = () =>
      Effect.promise(() =>
        f.handler(
          new Request("http://orion.test/api/device-share/agent/artifacts/recording", {
            headers: { authorization: `Bearer ${agentDevice.token}` },
          }),
        ),
      );
    yield* TestClock.adjust("10 minutes");
    expect(yield* f.target.environmentsUsingDevices).toBe(0);

    // An agent that disconnects mid-download stops counting once the window passes.
    const abandoned = yield* download();
    expect(abandoned.status).toBe(200);
    yield* Effect.promise(() => abandoned.body!.cancel());
    yield* TestClock.adjust("10 minutes");
    expect(yield* f.target.environmentsUsingDevices).toBe(0);

    const response = yield* download();
    const reader = response.body!.getReader();
    yield* Effect.promise(() => reader.read());
    yield* TestClock.adjust("1 hour");
    expect(yield* f.target.environmentsUsingDevices).toBe(1);
    // Releasing the devices does not stop counting a request that is still open.
    yield* f.target.command(
      { subject: `device-host:${sourceId}`, sessionId: f.grant.sessionId },
      { operation: "release" },
    );
    expect(yield* f.target.environmentsUsingDevices).toBe(1);
    f.openStreams.at(-1)!.close();
    while (!(yield* Effect.promise(() => reader.read())).done);
    yield* TestClock.adjust("10 minutes");
    expect(yield* f.target.environmentsUsingDevices).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("revoking a grant on the device environment closes that environment's sessions", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const peer = { subject: `device-host:${sourceId}`, sessionId: f.grant.sessionId };
    yield* f.target.command(peer, {
      operation: "open",
      input: {
        threadId: ThreadId.make("thread"),
        hostId: LOCAL_DEVICE_HOST_ID,
        deviceId: "emulator-5554",
        platform: "android",
      },
    });
    expect((yield* f.targetDevices.state).sessions).toHaveLength(1);
    // The source cannot release its own claims once its access is revoked.
    yield* f.target.revokeGrant(f.grant.sessionId);
    expect((yield* f.targetDevices.state).sessions).toEqual([]);
  }).pipe(Effect.scoped),
);
