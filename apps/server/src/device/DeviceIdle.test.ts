import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, LOCAL_DEVICE_HOST_ID, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerSettings from "../serverSettings.ts";
import { agentDeviceSession } from "./AgentDeviceTarget.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as DeviceIdle from "./DeviceIdle.ts";
import * as DeviceService from "./DeviceService.ts";
import { devicePeerThreadPrefix, environmentDeviceHostId } from "./EnvironmentDeviceHost.ts";

type BootRecords = Effect.Success<DeviceIdle.DeviceBootLedger["load"]>;

const pixelRecord = {
  hostId: LOCAL_DEVICE_HOST_ID,
  deviceId: "emulator-5554",
  name: "Pixel_API_35",
  platform: "android",
} as const;
const OWN_ENVIRONMENT = "environment-under-test";

const decoder = new TextDecoder();
const decodeRpcBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ params: Schema.Struct({ session: Schema.String }) })),
);

/**
 * One local Android host whose hub boots the Pixel_API_35 AVD as emulator-5554,
 * and an agent-device daemon that records the sessions it is asked to close.
 */
const fixture = Effect.fn("fixture")(function* (
  saved: Ref.Ref<BootRecords>,
  options: { readonly gate?: Deferred.Deferred<void> } = {},
) {
  const settings = yield* Ref.make({
    ...DEFAULT_SERVER_SETTINGS,
    enableAgentDeviceAccess: true,
  });
  const releaseError = yield* Ref.make<string | null>(null);
  const daemonRunning = yield* Ref.make(true);
  const starts: string[] = [];
  const calls: string[] = [];
  let booted = false;
  const ready: DeviceHost.DeviceHostReady = {
    nodePath: process.execPath,
    hub: { origin: "http://device.test" },
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    run: () => Effect.succeed({ code: 0, stdout: "Pixel_API_35\n", stderr: "" }),
  };
  const agentDevice = { baseUrl: "http://agent.test", token: "agent-token", entryPath: "" };
  const host: DeviceHost.DeviceHost["Service"] = {
    id: LOCAL_DEVICE_HOST_ID,
    summary: Effect.succeed({
      id: LOCAL_DEVICE_HOST_ID,
      kind: "local",
      label: "Test server",
      platforms: [{ platform: "android", available: true }],
      hubInstalled: true,
      agentDeviceInstalled: true,
    }),
    platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
    ensureReady: () => Effect.sync(() => (starts.push("start"), ready)),
    ensureAgentReady: () => Effect.sync(() => (starts.push("start"), { ...ready, agentDevice })),
    current: Effect.sync(() => (starts.length > 0 ? ready : null)),
    stopAgent: Effect.void,
    stop: Effect.void,
  };
  const httpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.url === "http://agent.test/rpc") {
        const body = decodeRpcBody(
          request.body._tag === "Uint8Array" ? decoder.decode(request.body.body) : "{}",
        );
        calls.push(`release ${body.params.session}`);
        if (options.gate) yield* Deferred.await(options.gate);
        const code = yield* Ref.get(releaseError);
        return HttpClientResponse.fromWeb(
          request,
          code === null
            ? Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } })
            : code === "DOWN"
              ? new Response("unavailable", { status: 503 })
              : Response.json({ jsonrpc: "2.0", id: 1, error: { message: code, data: { code } } }),
        );
      }
      if (request.url.endsWith("/shutdown")) {
        calls.push("shutdown");
        booted = false;
        return HttpClientResponse.fromWeb(request, Response.json({ ok: true }));
      }
      if (request.url.endsWith("/boot")) {
        booted = true;
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ ok: true, serial: "emulator-5554" }),
        );
      }
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          simulators: [],
          emulators: booted
            ? [
                {
                  id: "emulator-5554",
                  name: "Pixel_API_35",
                  platform: "android",
                  version: "Android 15",
                  booted: true,
                  physical: false,
                },
              ]
            : [],
        }),
      );
    }),
  );
  const inner = yield* DeviceService.makeWithHosts(new Map([[host.id, host]]), undefined, () =>
    Effect.succeed("/agent-device.json"),
  ).pipe(
    Effect.provideService(
      ServerSettings.ServerSettingsService,
      ServerSettings.ServerSettingsService.of({
        updateProviderInstance: () => Effect.die("Unexpected provider mutation"),
        withSettingsSnapshot: (use) => Effect.flatMap(Ref.get(settings), use),
        start: Effect.void,
        ready: Effect.void,
        getSettings: Ref.get(settings),
        updateSettings: (patch) =>
          Ref.updateAndGet(settings, (current) => ({
            ...current,
            enableDeviceSupport: patch.enableDeviceSupport ?? current.enableDeviceSupport,
          })),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      }),
    ),
    Effect.provideService(HttpClient.HttpClient, httpClient),
  );
  const idle = yield* DeviceIdle.make(inner, {
    ledger: { load: Ref.get(saved), save: (records) => Ref.set(saved, records) },
    agentEndpoint: () =>
      Ref.get(daemonRunning).pipe(Effect.map((running) => (running ? agentDevice : null))),
    environmentId: OWN_ENVIRONMENT,
  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
  const bootElsewhere = () => {
    booted = true;
  };
  return { ...idle, settings, releaseError, daemonRunning, starts, calls, bootElsewhere };
});

const threadId = ThreadId.make("thread-1");
const release = (thread: string, deviceId = "Pixel_API_35") =>
  `release ${agentDeviceSession(thread, LOCAL_DEVICE_HOST_ID, deviceId)}`;
const notBusy = () => Effect.succeed(false);
const handBackOnly = { shutdownAfter: null, agentAccess: true, threadBusy: notBusy };
const withShutdown = { ...handBackOnly, shutdownAfter: Duration.minutes(10) };

/** What the device_open tool does: target the agent session, then open the device. */
const agentOpen = (
  service: DeviceService.DeviceService["Service"],
  thread = threadId,
  deviceId = "Pixel_API_35",
) =>
  service
    .agentTarget({ threadId: thread, hostId: LOCAL_DEVICE_HOST_ID, deviceId })
    .pipe(Effect.andThen(service.open({ threadId: thread, deviceId, platform: "android" })));

describe("hand-back", () => {
  it.effect(
    "device_close releases the session device_open handed out, even after an AVD boots",
    () =>
      Effect.gen(function* () {
        const { service, calls } = yield* fixture(yield* Ref.make<BootRecords>([]));
        yield* service.configure({ enabled: true });
        const session = yield* agentOpen(service);
        expect(session.deviceId).toBe("emulator-5554");
        yield* service.close({ threadId });
        // The agent's session was named from the AVD before it booted.
        expect(calls).toEqual([release("thread-1", "Pixel_API_35")]);
        const state = yield* service.state;
        expect(state.sessions).toEqual([]);
        expect(state.devices[0]?.booted).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect("closing succeeds when the daemon does not answer, and the sweep retries", () =>
    Effect.gen(function* () {
      const { service, sweep, calls, releaseError } = yield* fixture(
        yield* Ref.make<BootRecords>([]),
      );
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);
      yield* Ref.set(releaseError, "DOWN");
      yield* service.close({ threadId });
      expect((yield* service.state).sessions).toEqual([]);

      yield* Ref.set(releaseError, null);
      yield* TestClock.adjust("6 minutes");
      yield* sweep(handBackOnly);
      yield* TestClock.adjust("6 minutes");
      yield* sweep(handBackOnly);
      expect(calls).toEqual([release("thread-1"), release("thread-1")]);
    }).pipe(Effect.scoped),
  );

  it.effect("treats a session agent-device no longer has, or a stopped daemon, as released", () =>
    Effect.gen(function* () {
      const { service, sweep, calls, releaseError, daemonRunning } = yield* fixture(
        yield* Ref.make<BootRecords>([]),
      );
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);
      yield* Ref.set(releaseError, "SESSION_NOT_FOUND");
      yield* service.close({ threadId });

      yield* agentOpen(service, threadId, "emulator-5554");
      yield* Ref.set(daemonRunning, false);
      yield* service.close({ threadId });
      yield* TestClock.adjust("6 minutes");
      yield* sweep(handBackOnly);
      expect(calls).toEqual([release("thread-1")]);
      expect((yield* service.state).sessions).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("releases an agent's hold left idle after its thread stops working", () =>
    Effect.gen(function* () {
      const { service, sweep, calls } = yield* fixture(yield* Ref.make<BootRecords>([]));
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);

      yield* TestClock.adjust("6 minutes");
      const busy = { ...handBackOnly, threadBusy: () => Effect.succeed(true) };
      expect((yield* sweep(busy)).handedBack).toEqual([]);
      // The turn just ended, so the idle period starts now.
      yield* TestClock.adjust("4 minutes");
      expect((yield* sweep(handBackOnly)).handedBack).toEqual([]);
      yield* TestClock.adjust("2 minutes");
      expect((yield* sweep(handBackOnly)).handedBack).toHaveLength(1);
      expect(calls).toEqual([release("thread-1")]);
      expect((yield* service.state).devices[0]?.booted).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves sessions the user opened from the Device panel alone", () =>
    Effect.gen(function* () {
      const { service, sweep, calls } = yield* fixture(yield* Ref.make<BootRecords>([]));
      yield* service.configure({ enabled: true });
      yield* service.open({ threadId, deviceId: "Pixel_API_35", platform: "android" });
      yield* TestClock.adjust("1 hour");
      expect((yield* sweep(handBackOnly)).handedBack).toEqual([]);
      expect((yield* service.state).sessions).toHaveLength(1);
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("never releases or shuts down a device someone is watching", () =>
    Effect.gen(function* () {
      const { service, sweep, activity } = yield* fixture(yield* Ref.make<BootRecords>([]));
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* activity.watch(LOCAL_DEVICE_HOST_ID, "emulator-5554");
          yield* TestClock.adjust("1 hour");
          expect(yield* sweep(withShutdown)).toEqual({ handedBack: [], stopped: [] });
        }),
      );
      yield* TestClock.adjust("6 minutes");
      expect((yield* sweep(withShutdown)).handedBack).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("a reopen waits for an idle release in progress instead of being dropped by it", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const { service, sweep, calls } = yield* fixture(yield* Ref.make<BootRecords>([]), { gate });
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);
      yield* TestClock.adjust("6 minutes");

      const releasing = yield* sweep(handBackOnly).pipe(Effect.forkChild);
      while (calls.length === 0) yield* Effect.yieldNow;
      const reopening = yield* agentOpen(service, threadId, "emulator-5554").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(releasing);
      yield* Fiber.join(reopening);

      expect((yield* service.state).sessions).toHaveLength(1);
      yield* service.close({ threadId });
      expect(calls).toEqual([release("thread-1"), release("thread-1", "emulator-5554")]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "releases every agent's claim, including a connected environment's, before power-off",
    () =>
      Effect.gen(function* () {
        const { service, activity, calls } = yield* fixture(yield* Ref.make<BootRecords>([]));
        yield* service.configure({ enabled: true });
        yield* agentOpen(service);
        const prefix = devicePeerThreadPrefix("agent-environment");
        activity.notePeer(prefix, "agent-environment");
        yield* service.open({
          threadId: ThreadId.make(`${prefix}peer-thread`),
          deviceId: "emulator-5554",
          platform: "android",
        });
        yield* service.shutdown({ deviceId: "emulator-5554", platform: "android" });
        const peerName = (deviceId: string) =>
          `release ${agentDeviceSession("agent-environment:peer-thread", environmentDeviceHostId(OWN_ENVIRONMENT), deviceId)}`;
        expect(calls).toEqual([
          release("thread-1"),
          peerName("emulator-5554"),
          peerName("Pixel_API_35"),
          "shutdown",
        ]);
      }).pipe(Effect.scoped),
  );
});

describe("idle shutdown", () => {
  it.effect("shuts down a device it booted once nobody has held it for the idle period", () =>
    Effect.gen(function* () {
      const saved = yield* Ref.make<BootRecords>([]);
      const { service, sweep, calls } = yield* fixture(saved);
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);
      expect(yield* Ref.get(saved)).toEqual([pixelRecord]);

      yield* TestClock.adjust("6 minutes");
      expect((yield* sweep(withShutdown)).stopped).toEqual([]);
      yield* TestClock.adjust("9 minutes");
      expect((yield* sweep(withShutdown)).stopped).toEqual([]);
      yield* TestClock.adjust("2 minutes");
      expect((yield* sweep(withShutdown)).stopped).toEqual([
        { hostId: LOCAL_DEVICE_HOST_ID, deviceId: "emulator-5554", platform: "android" },
      ]);
      expect(calls).toEqual([release("thread-1"), "shutdown"]);
      expect(yield* Ref.get(saved)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a device while a thread works on it after its hold was released", () =>
    Effect.gen(function* () {
      const { service, sweep } = yield* fixture(yield* Ref.make<BootRecords>([]));
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);
      yield* TestClock.adjust("6 minutes");
      expect((yield* sweep(withShutdown)).handedBack).toHaveLength(1);

      // The agent kept driving the device through its selector in a later turn.
      const working = { ...withShutdown, threadBusy: () => Effect.succeed(true) };
      yield* TestClock.adjust("20 minutes");
      expect((yield* sweep(working)).stopped).toEqual([]);
      yield* TestClock.adjust("11 minutes");
      expect((yield* sweep(withShutdown)).stopped).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "powering off from close forgets the device, so a later external boot is not touched",
    () =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<BootRecords>([]);
        const { service } = yield* fixture(saved);
        yield* service.configure({ enabled: true });
        yield* agentOpen(service);
        yield* service.close({ threadId, shutdown: true });
        expect(yield* Ref.get(saved)).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect("never shuts down a device booted outside styal", () =>
    Effect.gen(function* () {
      const saved = yield* Ref.make<BootRecords>([]);
      const { service, sweep, calls, bootElsewhere } = yield* fixture(saved);
      bootElsewhere();
      yield* service.configure({ enabled: true });
      yield* agentOpen(service, threadId, "emulator-5554");
      expect(yield* Ref.get(saved)).toEqual([]);

      yield* TestClock.adjust("1 hour");
      expect((yield* sweep(withShutdown)).stopped).toEqual([]);
      expect(calls).not.toContain("shutdown");
    }).pipe(Effect.scoped),
  );

  it.effect("shuts down a device booted before a restart, starting the local hub if needed", () =>
    Effect.gen(function* () {
      const saved = yield* Ref.make<BootRecords>([pixelRecord]);
      const { sweep, settings, starts, bootElsewhere } = yield* fixture(saved);
      bootElsewhere();
      yield* Ref.update(settings, (current) => ({ ...current, enableDeviceSupport: true }));

      yield* TestClock.adjust("9 minutes");
      expect((yield* sweep(withShutdown)).stopped).toEqual([]);
      expect(starts).toEqual([]);
      yield* TestClock.adjust("2 minutes");
      expect((yield* sweep(withShutdown)).stopped).toHaveLength(1);
      expect(starts).toContain("start");
      expect(yield* Ref.get(saved)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("forgets a device that was turned off while the server was down", () =>
    Effect.gen(function* () {
      const saved = yield* Ref.make<BootRecords>([pixelRecord]);
      const { service, sweep, calls } = yield* fixture(saved);
      yield* service.configure({ enabled: true });
      yield* TestClock.adjust("11 minutes");
      expect((yield* sweep(withShutdown)).stopped).toEqual([]);
      expect(calls).toEqual([]);
      expect(yield* Ref.get(saved)).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
