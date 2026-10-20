import { expect, it } from "@effect/vitest";
import { DeviceToolListResult, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";
import * as DeviceService from "./DeviceService.ts";

it.effect("keeps hosts independent when serials collide and another host fails", () =>
  Effect.gen(function* () {
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            simulators: [],
            emulators: [
              {
                id: "emulator-5554",
                name: "Pixel",
                version: "36",
                platform: "android",
                booted: true,
                physical: false,
              },
            ],
          }),
        ),
      ),
    );
    const host = (id: string, failed = false): DeviceHost.DeviceHost["Service"] => {
      const run = (command: string) =>
        Effect.succeed({
          stdout: command === "emulator" ? "" : " V....D libx264",
          stderr: "",
          code: 0,
        });
      const ready: DeviceHost.DeviceHostAgentReady = {
        nodePath: process.execPath,
        hub: { origin: `http://${id}` },
        devices: makeDeviceHubOperations({
          hostId: id,
          origin: `http://${id}`,
          http,
          run,
          androidAvailable: Effect.succeed(true),
        }),
        agentDevice: { baseUrl: `http://${id}`, token: "test", entryPath: "/agent-device" },
        run,
        helpers: { serveSimAxSettings: null, serveSimCli: null },
      };
      return {
        id,
        summary: Effect.succeed({
          id,
          label: id,
          kind: id === "b" ? "ssh" : "local",
          hubInstalled: true,
          agentDeviceInstalled: true,
          platforms: id === "b" ? [] : [{ platform: "android", available: true }],
        }),
        platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
        ensureReady: () =>
          failed
            ? Effect.fail(
                new DeviceHost.DeviceHostError({
                  hostId: id,
                  step: "connect",
                  cause: new Error("offline"),
                }),
              )
            : Effect.succeed(ready),
        ensureAgentReady: () => Effect.succeed(ready),
        current: Effect.succeed(ready),
        stopAgent: Effect.void,
        stop: Effect.void,
      };
    };
    const hosts = new Map(["a", "b", "offline"].map((id) => [id, host(id, id === "offline")]));
    const writeStarted = yield* Deferred.make<void>();
    const finishWrite = yield* Deferred.make<void>();
    const order: string[] = [];
    const service = yield* DeviceService.makeWithHosts(hosts, undefined, () =>
      Effect.gen(function* () {
        order.push("write started");
        yield* Deferred.succeed(writeStarted, undefined);
        yield* Deferred.await(finishWrite);
        order.push("write finished");
        return "/host-config.json";
      }),
    ).pipe(Effect.provide(NodeCrypto.layer));
    expect(yield* service.agentReadinessIfSupported("b")).not.toBeNull();
    const listed = yield* service.list;
    expect(listed.devices.map((device) => device.hostId).sort()).toEqual(["a", "b"]);
    expect(listed.hostStatuses.offline?.status).toBe("failed");
    const threadId = ThreadId.make("thread");
    for (const hostId of ["a", "b"])
      yield* service.open({ threadId, hostId, deviceId: "emulator-5554", platform: "android" });
    yield* service.close({ threadId, hostId: "a", deviceId: "emulator-5554" });
    const state = yield* service.state;
    expect(state.devices).toHaveLength(2);
    expect(state.sessions.map((session) => session.hostId)).toEqual(["b"]);
    expect(state.hostStatuses.a?.status).toBe("ready");
    expect(state.hostStatuses.offline?.status).toBe("failed");
    const targeting = yield* service
      .agentTarget({ threadId, hostId: "b", deviceId: "emulator-5554" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(writeStarted);
    const replacing = yield* service
      .withLifecycleLock(
        Effect.gen(function* () {
          order.push("replace");
          hosts.set("b", host("b"));
          yield* service.refreshHosts;
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.succeed(finishWrite, undefined);
    yield* Fiber.join(targeting);
    yield* Fiber.join(replacing);
    expect(order).toEqual(["write started", "write finished", "replace"]);
    const replaced = yield* service.state;
    expect(replaced.sessions).toEqual([]);
    expect(replaced.devices.map((device) => device.hostId)).toEqual(["a"]);
    expect(replaced.hostStatuses.b).toBeUndefined();
    yield* service.open({ threadId, hostId: "b", deviceId: "emulator-5554", platform: "android" });
    hosts.delete("b");
    yield* service.refreshHosts;
    yield* service.setHostStatus("b", { status: "ready" });
    expect((yield* service.state).hostStatuses.b).toBeUndefined();
    expect((yield* service.state).sessions).toEqual([]);
    yield* service.agentReadinessIfSupported("a");
    expect((yield* service.state).hostStatuses.a?.status).toBe("ready");
    yield* service.configure({ enabled: false });
    expect((yield* service.state).hostStatuses).toEqual({});
  }).pipe(
    Effect.provide(
      ServerSettings.layerTest({
        enableDeviceSupport: true,
        enableAgentDeviceAccess: true,
      }),
    ),
  ),
);

it.effect(
  "opens environment emulators through their owning server without running local probes",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("peer-thread");
      const device = {
        id: "emulator-5554",
        hostId: "peer",
        name: "Pixel",
        platform: "android" as const,
        version: "36",
        booted: true,
        physical: false,
      };
      const opened: string[] = [];
      const unsupported = () => Effect.die("Unexpected device operation");
      const ready: DeviceHost.DeviceHostReady = {
        nodePath: "",
        hub: { origin: "http://peer" },
        run: unsupported,
        helpers: { serveSimAxSettings: null, serveSimCli: null },
        remote: {
          list: Effect.succeed({
            environmentId: EnvironmentId.make("peer-environment"),
            sourceEnvironmentId: EnvironmentId.make("local-environment"),
            host: {
              id: "peer",
              label: "Peer",
              kind: "local",
              hubInstalled: true,
              agentDeviceInstalled: true,
              platforms: [{ platform: "android", available: true }],
            },
            devices: [device],
            sessions: [],
          }),
          open: (input) =>
            Effect.sync(() => {
              opened.push(input.deviceId);
              return {
                threadId,
                hostId: "peer",
                deviceId: device.id,
                platform: device.platform,
                openedAt: "2026-01-01T00:00:00.000Z",
              };
            }),
          close: unsupported,
          shutdown: unsupported,
          detail: unsupported,
          action: unsupported,
          screenshot: unsupported,
        },
      };
      const host: DeviceHost.DeviceHost["Service"] = {
        id: "peer",
        summary: Effect.succeed({
          id: "peer",
          label: "Peer",
          kind: "environment",
          hubInstalled: true,
          agentDeviceInstalled: true,
          platforms: [{ platform: "android", available: true }],
        }),
        platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
        ensureReady: () => Effect.succeed(ready),
        ensureAgentReady: unsupported,
        current: Effect.succeed(ready),
        stopAgent: Effect.void,
        stop: Effect.void,
      };
      const service = yield* DeviceService.makeWithHosts(new Map([["peer", host]])).pipe(
        Effect.provide(NodeCrypto.layer),
        Effect.provideService(HttpClient.HttpClient, HttpClient.make(unsupported)),
      );
      const session = yield* service.open({
        threadId,
        hostId: "peer",
        deviceId: device.id,
        platform: "android",
      });
      expect(session.deviceId).toBe(device.id);
      expect(opened).toEqual([device.id]);
      expect((yield* service.state).sessions).toEqual([session]);
    }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true }))),
);

it.effect("does not hold local device work behind a connected environment that is waiting", () =>
  Effect.gen(function* () {
    const peerStarted = yield* Deferred.make<void>();
    const ready = {
get devices() {
      return makeDeviceHubOperations({ hostId: LOCAL_DEVICE_HOST_ID, origin: ready.hub.origin, http: http, run: ready.run, androidAvailable: Effect.succeed(true) });
    },
      nodePath: process.execPath,
      hub: { origin: "http://local" },
      agentDevice: { baseUrl: "http://local", token: "test", entryPath: "/agent-device" },
      run: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
      helpers: { serveSimAxSettings: null, serveSimCli: null },
    };
    const host = (id: string, kind: "local" | "environment"): DeviceHost.DeviceHost["Service"] => {
      // The environment never answers, like a peer that went to sleep mid-request.
      const waiting = Deferred.succeed(peerStarted, undefined).pipe(Effect.andThen(Effect.never));
      return {
        id,
        summary: Effect.succeed({
          id,
          label: id,
          kind,
          hubInstalled: true,
          agentDeviceInstalled: true,
          platforms: [{ platform: "android", available: true }],
        }),
        platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
        ensureReady: () => (kind === "environment" ? waiting : Effect.succeed(ready)),
        ensureAgentReady: () => (kind === "environment" ? waiting : Effect.succeed(ready)),
        current: Effect.succeed(null),
        stopAgent: Effect.void,
        stop: Effect.void,
      };
    };
    const service = yield* DeviceService.makeWithHosts(
      new Map([
        ["local", host("local", "local")],
        ["peer", host("peer", "environment")],
      ]),
    ).pipe(
      Effect.provide(NodeCrypto.layer),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}))),
        ),
      ),
    );
    const waiting = yield* service.agentReadinessIfSupported("peer").pipe(Effect.forkChild);
    yield* Deferred.await(peerStarted);
    expect((yield* service.readiness("local")).hostId).toBe("local");
    expect(yield* service.agentReadinessIfSupported("local")).not.toBeNull();
    yield* Fiber.interrupt(waiting);
  }).pipe(
    Effect.provide(
      ServerSettings.layerTest({ enableDeviceSupport: true, enableAgentDeviceAccess: true }),
    ),
  ),
);

it.effect(
  "drops an environment agent credential when access is turned off while it is issued",
  () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const issue = yield* Deferred.make<void>();
      const stopped: string[] = [];
      const written: string[] = [];
      const ready = {
get devices() {
      return makeDeviceHubOperations({ hostId: LOCAL_DEVICE_HOST_ID, origin: ready.hub.origin, http: http, run: ready.run, androidAvailable: Effect.succeed(true) });
    },
        nodePath: process.execPath,
        hub: { origin: "http://peer" },
        run: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
        helpers: { serveSimAxSettings: null, serveSimCli: null },
      };
      const peer: DeviceHost.DeviceHost["Service"] = {
        id: "peer",
        summary: Effect.succeed({
          id: "peer",
          label: "Peer",
          kind: "environment",
          hubInstalled: true,
          agentDeviceInstalled: true,
          platforms: [{ platform: "android", available: true }],
        }),
        platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
        ensureReady: () => Effect.succeed(ready),
        // The device environment is still issuing the credential when access turns off.
        ensureAgentReady: () =>
          Deferred.succeed(requested, undefined).pipe(
            Effect.andThen(Deferred.await(issue)),
            Effect.as({
              ...ready,
              agentDevice: { baseUrl: "http://peer/agent", token: "issued", entryPath: "" },
            }),
          ),
        current: Effect.succeed(ready),
        stopAgent: Effect.sync(() => {
          stopped.push("stop-agent");
        }),
        stop: Effect.void,
      };
      const service = yield* DeviceService.makeWithHosts(
        new Map([["peer", peer]]),
        undefined,
        (_hostId, ready) =>
          Effect.sync(() => {
            written.push(ready.agentDevice.token);
            return "/host-config.json";
          }),
      ).pipe(
        Effect.provide(NodeCrypto.layer),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}))),
          ),
        ),
      );
      const targeting = yield* service
        .agentTarget({
          threadId: ThreadId.make("thread"),
          hostId: "peer",
          deviceId: "emulator-5554",
        })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(requested);
      yield* service.configure({ agentAccessEnabled: false });
      yield* Deferred.succeed(issue, undefined);
      const error = yield* Fiber.join(targeting);
      expect(error).toMatchObject({ reason: "Agent device access was turned off." });
      expect(written).toEqual([]);
      expect(stopped).toEqual(["stop-agent", "stop-agent"]);
    }).pipe(
      Effect.provide(
        ServerSettings.layerTest({
          enableDeviceSupport: true,
          enableAgentDeviceAccess: true,
        }),
      ),
    ),
);

const encodeToolListResult = Schema.encodeEffect(DeviceToolListResult);
// MCP structured content must be a JSON object, which rejects keys set to undefined.
const isJsonObject = Schema.is(Schema.JsonObject);

it.effect("omits a missing host status detail so device_list stays valid MCP JSON", () =>
  Effect.gen(function* () {
    const host: DeviceHost.DeviceHost["Service"] = {
      id: "local",
      summary: Effect.succeed({
        id: "local",
        label: "local",
        kind: "local",
        hubInstalled: true,
        agentDeviceInstalled: true,
        platforms: [],
      }),
      platformAvailability: (platform) => Effect.succeed({ platform, available: false }),
      ensureReady: () => Effect.never,
      ensureAgentReady: () => Effect.never,
      current: Effect.never,
      stopAgent: Effect.void,
      stop: Effect.void,
    };
    const service = yield* DeviceService.makeWithHosts(new Map([["local", host]])).pipe(
      Effect.provide(NodeCrypto.layer),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unused")),
      ),
    );
    yield* service.setHostStatus("local", { status: "ready", detail: "Hub ready" });
    yield* service.setHostStatus("local", { status: "starting", detail: undefined });
    const state = yield* service.state;
    expect(state.hostStatuses.local).toEqual({ status: "starting" });
    expect("hostStatusDetail" in state).toBe(false);
    const encoded = yield* encodeToolListResult({
      hostStatuses: state.hostStatuses,
      hosts: state.hosts,
      devices: state.devices,
      open: [],
      openInOtherThreads: [],
    });
    expect(isJsonObject(encoded)).toBe(true);
  }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true }))),
);
