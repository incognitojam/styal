import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, LOCAL_DEVICE_HOST_ID, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import {
  agentDeviceConfigPath,
  agentDeviceSession,
  readAgentDeviceConfig,
  writeAgentDeviceConfig,
} from "./AgentDeviceTarget.ts";
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
  options: {
    readonly gate?: Deferred.Deferred<void>;
    readonly saveGate?: Deferred.Deferred<void>;
    /** Runs an agent-device daemon per device, like EAS, whose endpoints are saved here. */
    readonly perDeviceDaemonDir?: string;
  } = {},
) {
  for (const [thread, hostId] of [
    ["thread-1", LOCAL_DEVICE_HOST_ID],
    ["thread-2", LOCAL_DEVICE_HOST_ID],
    ["agent-environment:peer-thread", environmentDeviceHostId(OWN_ENVIRONMENT)],
  ] as const) {
    for (const deviceId of ["Pixel_API_35", "emulator-5554"]) {
      knownSessionNames.set(
        sessionKey(thread, hostId, deviceId),
        yield* agentDeviceSession(thread, hostId, deviceId).pipe(Effect.provide(NodeCrypto.layer)),
      );
    }
  }
  const settings = yield* Ref.make({
    ...DEFAULT_SERVER_SETTINGS,
    enableAgentDeviceAccess: true,
  });
  const releaseError = yield* Ref.make<string | null>(null);
  const sessionErrors = new Map<string, string>();
  const busy = new Set<string>();
  /** Threads that are not "idle"; `busy` marks working ones. */
  const ended = new Map<string, "archived" | "missing">();
  const releasedNames = yield* Ref.make<ReadonlyArray<string>>([]);
  const ledgerSaves = { count: 0 };
  const daemonRunning = yield* Ref.make(true);
  const starts: string[] = [];
  const calls: string[] = [];
  let booted = false;
  const ready: DeviceHost.DeviceHostReady = {
    get devices() {
      const operations = makeDeviceHubOperations({
        hostId: LOCAL_DEVICE_HOST_ID,
        origin: ready.hub.origin,
        http: httpClient,
        run: ready.run,
        androidAvailable: Effect.succeed(true),
      });
      return options.perDeviceDaemonDir === undefined
        ? operations
        : {
            ...operations,
            agentEndpoint: (deviceId: string) =>
              Effect.succeed({ ...agentDevice, agentDeviceId: deviceId }),
          };
    },
    nodePath: process.execPath,
    hub: { origin: "http://device.test" },
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    run: (command) =>
      Effect.succeed({
        code: 0,
        stdout: command === process.execPath ? " V....D libx264" : "Pixel_API_35\n",
        stderr: "",
      }),
  };
  const agentDevice = { baseUrl: "http://agent.test", token: "agent-token", entryPath: "" };
  const host: DeviceHost.DeviceHost["Service"] = {
    id: LOCAL_DEVICE_HOST_ID,
    label: "Test host",
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
    ensureAgentReady: () =>
      Effect.sync(
        () => (
          starts.push("start"),
          { ...ready, agentDevice: options.perDeviceDaemonDir === undefined ? agentDevice : null }
        ),
      ),
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
        const code = sessionErrors.get(body.params.session) ?? (yield* Ref.get(releaseError));
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
  const daemonDir = options.perDeviceDaemonDir;
  const inner = yield* DeviceService.makeWithHosts(
    new Map([[host.id, host]]),
    undefined,
    daemonDir === undefined
      ? () => Effect.succeed("/agent-device.json")
      : (hostId, endpoint, deviceId) =>
          Effect.gen(function* () {
            const file = yield* agentDeviceConfigPath(
              daemonDir,
              hostId,
              yield* Path.Path,
              deviceId,
            );
            yield* writeAgentDeviceConfig(file, endpoint);
            return file;
          }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
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
    Effect.provide(NodeCrypto.layer),
  );
  const idle = yield* DeviceIdle.make(inner, {
    ledger: {
      load: Ref.get(saved),
      save: (records) =>
        Effect.gen(function* () {
          ledgerSaves.count++;
          if (options.saveGate) yield* Deferred.await(options.saveGate);
          yield* Ref.set(saved, records);
        }),
    },
    releasedSessions: {
      load: Ref.get(releasedNames),
      save: (names) => Ref.set(releasedNames, names),
    },
    agentEndpoint: (hostId, deviceId) =>
      daemonDir === undefined
        ? Ref.get(daemonRunning).pipe(Effect.map((running) => (running ? agentDevice : null)))
        : readAgentDeviceConfig(daemonDir, hostId, deviceId).pipe(
            Effect.map((saved) => (saved ? { ...saved, entryPath: "" } : null)),
            Effect.provide(NodeServices.layer),
          ),
    environmentId: OWN_ENVIRONMENT,
    threadStatus: (thread) =>
      Effect.sync(() => (busy.has(thread) ? "working" : (ended.get(thread) ?? "idle"))),
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.provide(NodeCrypto.layer),
  );
  const bootElsewhere = () => {
    booted = true;
  };
  return {
    ...idle,
    settings,
    releaseError,
    sessionErrors,
    daemonRunning,
    starts,
    calls,
    busy,
    ended,
    releasedNames,
    ledgerSaves,
    bootElsewhere,
  };
});

const threadId = ThreadId.make("thread-1");
const thread2 = ThreadId.make("thread-2");
/** Session names the tests expect, computed once by `fixture`, which every test calls first. */
const knownSessionNames = new Map<string, string>();
const sessionKey = (thread: string, hostId: string, deviceId: string) =>
  `${thread}\u0000${hostId}\u0000${deviceId}`;
const agentSessionName = (thread: string, hostId: string, deviceId: string) => {
  const key = sessionKey(thread, hostId, deviceId);
  const name = knownSessionNames.get(key);
  if (name === undefined) throw new Error(`No session name computed for ${key}`);
  return name;
};
const sessionName = (thread: string, deviceId = "Pixel_API_35") =>
  agentSessionName(thread, LOCAL_DEVICE_HOST_ID, deviceId);
const release = (thread: string, deviceId = "Pixel_API_35") =>
  `release ${sessionName(thread, deviceId)}`;
const withShutdown = { shutdownAfter: Duration.minutes(10), agentAccess: true };

/** What the device_open tool does: target the agent session, then open the device. */
const agentOpen = (
  service: DeviceService.DeviceService["Service"],
  thread = threadId,
  deviceId = "Pixel_API_35",
  takeOver?: boolean,
) =>
  service.agentTarget({ threadId: thread, hostId: LOCAL_DEVICE_HOST_ID, deviceId }).pipe(
    Effect.andThen(
      service.open(
        {
          threadId: thread,
          deviceId,
          platform: "android",
          ...(takeOver === undefined ? {} : { takeOver }),
        },
        { agentRequested: true },
      ),
    ),
  );
/**
 * The whole device_open tool: it targets the device first unless the host runs a daemon
 * per device, and targets the opened device again once it runs.
 */
const deviceOpenTool = (
  service: DeviceService.DeviceService["Service"],
  options: { readonly thread?: ThreadId; readonly targetFirst?: boolean } = {},
) =>
  Effect.gen(function* () {
    const thread = options.thread ?? threadId;
    const deviceId = "Pixel_API_35";
    if (options.targetFirst !== false)
      yield* service.agentTarget({ threadId: thread, hostId: LOCAL_DEVICE_HOST_ID, deviceId });
    const session = yield* service.open(
      { threadId: thread, deviceId, platform: "android" },
      { agentRequested: true },
    );
    yield* service.agentTarget({
      threadId: thread,
      hostId: session.hostId,
      deviceId: session.deviceId,
    });
    return session;
  });
const threads = (service: DeviceService.DeviceService["Service"]) =>
  service.state.pipe(Effect.map((state) => state.sessions.map((session) => session.threadId)));

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

  it.effect("device_close releases the claim on a device with its own agent-device daemon", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-idle-" });
      const { service, calls } = yield* fixture(yield* Ref.make<BootRecords>([]), {
        perDeviceDaemonDir: dir,
      });
      yield* service.configure({ enabled: true });
      yield* deviceOpenTool(service, { targetFirst: false });
      yield* service.close({ threadId });
      expect(calls).toEqual([release("thread-1"), release("thread-1", "emulator-5554")]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("device_open hands out the booted device's session again after a power-off", () =>
    Effect.gen(function* () {
      const { service, releasedNames } = yield* fixture(yield* Ref.make<BootRecords>([]));
      yield* service.configure({ enabled: true });
      yield* deviceOpenTool(service);
      yield* service.close({ threadId, shutdown: true });
      expect(yield* Ref.get(releasedNames)).toContain(sessionName("thread-1", "emulator-5554"));
      yield* deviceOpenTool(service);
      expect(yield* Ref.get(releasedNames)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("device_open hands out a serial session whose cleanup failed at power-off", () =>
    Effect.gen(function* () {
      const { service, releasedNames, sessionErrors } = yield* fixture(
        yield* Ref.make<BootRecords>([]),
      );
      yield* service.configure({ enabled: true });
      yield* deviceOpenTool(service);
      sessionErrors.set(sessionName("thread-1", "emulator-5554"), "CLEANUP_FAILED");
      yield* service.close({ threadId, shutdown: true });
      expect(yield* Ref.get(releasedNames)).toContain(sessionName("thread-1", "emulator-5554"));
      yield* deviceOpenTool(service);
      expect(yield* Ref.get(releasedNames)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("targeting after a reopen does not hand out a session a take-over released", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const { service, calls, releasedNames, daemonRunning } = yield* fixture(
        yield* Ref.make<BootRecords>([]),
        { gate },
      );
      yield* service.configure({ enabled: true });
      yield* deviceOpenTool(service);
      // Power off without a daemon, so both of thread-1's sessions stay refused without a release call.
      yield* Ref.set(daemonRunning, false);
      yield* service.close({ threadId, shutdown: true });
      yield* Ref.set(daemonRunning, true);
      const serial = sessionName("thread-1", "emulator-5554");
      expect(yield* Ref.get(releasedNames)).toContain(serial);
      calls.length = 0;

      // thread-1 reopens the AVD, and thread-2 takes it over before thread-1 targets the serial.
      yield* agentOpen(service);
      const takingOver = yield* agentOpen(service, thread2, "emulator-5554", true).pipe(
        Effect.forkChild,
      );
      while (calls.length === 0) yield* Effect.yieldNow;
      expect(calls).toEqual([release("thread-1")]);
      const targeting = yield* service
        .agentTarget({ threadId, hostId: LOCAL_DEVICE_HOST_ID, deviceId: "emulator-5554" })
        .pipe(Effect.forkChild);
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(takingOver);
      yield* Fiber.join(targeting);
      expect(yield* threads(service)).toEqual([thread2]);
      expect(yield* Ref.get(releasedNames)).toContain(serial);
    }).pipe(Effect.scoped),
  );

  it.effect("releases every session a thread was given when it reopened the device", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* fixture(yield* Ref.make<BootRecords>([]));
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);
      yield* agentOpen(service, threadId, "emulator-5554");
      yield* service.close({ threadId });
      expect(calls).toEqual([release("thread-1"), release("thread-1", "emulator-5554")]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "closing succeeds when the daemon does not answer, and the claim is retried at power-off",
    () =>
      Effect.gen(function* () {
        const { service, calls, releaseError } = yield* fixture(yield* Ref.make<BootRecords>([]));
        yield* service.configure({ enabled: true });
        yield* agentOpen(service);
        yield* Ref.set(releaseError, "DOWN");
        yield* service.close({ threadId });
        expect((yield* service.state).sessions).toEqual([]);

        yield* Ref.set(releaseError, null);
        yield* service.shutdown({ deviceId: "emulator-5554", platform: "android" });
        expect(calls).toEqual([release("thread-1"), release("thread-1"), "shutdown"]);
      }).pipe(Effect.scoped),
  );

  it.effect("treats a session agent-device no longer has, or a stopped daemon, as released", () =>
    Effect.gen(function* () {
      const { service, calls, releaseError, daemonRunning } = yield* fixture(
        yield* Ref.make<BootRecords>([]),
      );
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);
      yield* Ref.set(releaseError, "SESSION_NOT_FOUND");
      yield* service.close({ threadId });

      yield* agentOpen(service, threadId, "emulator-5554");
      yield* Ref.set(daemonRunning, false);
      yield* service.close({ threadId });
      yield* service.shutdown({ deviceId: "emulator-5554", platform: "android" });
      expect(calls).toEqual([release("thread-1"), "shutdown"]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps retrying an uncertain claim after failed cleanup removes its session", () =>
    Effect.gen(function* () {
      const { service, calls, releaseError, daemonRunning } = yield* fixture(
        yield* Ref.make<BootRecords>([]),
      );
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);
      yield* Ref.set(releaseError, "CLEANUP_FAILED");
      yield* service.close({ threadId });
      yield* Ref.set(releaseError, "SESSION_NOT_FOUND");
      yield* service.shutdown({ deviceId: "emulator-5554", platform: "android" });
      yield* service.shutdown({ deviceId: "emulator-5554", platform: "android" });
      expect(calls.filter((call) => call === release("thread-1"))).toHaveLength(3);

      yield* Ref.set(daemonRunning, false);
      yield* service.shutdown({ deviceId: "emulator-5554", platform: "android" });
      expect(calls.filter((call) => call === release("thread-1"))).toHaveLength(3);
    }).pipe(Effect.scoped),
  );

  it.effect("retries later session names after an earlier session was already absent", () =>
    Effect.gen(function* () {
      const { service, calls, sessionErrors } = yield* fixture(yield* Ref.make<BootRecords>([]));
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);
      yield* agentOpen(service, threadId, "emulator-5554");
      sessionErrors.set(sessionName("thread-1"), "SESSION_NOT_FOUND");
      sessionErrors.set(sessionName("thread-1", "emulator-5554"), "DOWN");
      yield* service.close({ threadId });

      sessionErrors.delete(sessionName("thread-1", "emulator-5554"));
      yield* service.shutdown({ deviceId: "emulator-5554", platform: "android" });
      expect(calls).toEqual([
        release("thread-1"),
        release("thread-1", "emulator-5554"),
        release("thread-1", "emulator-5554"),
        "shutdown",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("reopening does not confirm cleanup of an unresolved session", () =>
    Effect.gen(function* () {
      const { service, calls, releaseError } = yield* fixture(yield* Ref.make<BootRecords>([]));
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);
      yield* Ref.set(releaseError, "CLEANUP_FAILED");
      yield* service.close({ threadId });
      yield* Ref.set(releaseError, "SESSION_NOT_FOUND");
      yield* agentOpen(service, threadId, "emulator-5554");
      yield* service.close({ threadId });
      const attempted = calls.filter((call) => call === release("thread-1")).length;
      yield* service.shutdown({ deviceId: "emulator-5554", platform: "android" });
      expect(calls.filter((call) => call === release("thread-1"))).toHaveLength(attempted + 1);
    }).pipe(Effect.scoped),
  );

  it.effect("an uncertain missing session does not block cleanup of later sessions", () =>
    Effect.gen(function* () {
      const { service, calls, sessionErrors } = yield* fixture(yield* Ref.make<BootRecords>([]));
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);
      yield* agentOpen(service, threadId, "emulator-5554");
      sessionErrors.set(sessionName("thread-1"), "CLEANUP_FAILED");
      sessionErrors.set(sessionName("thread-1", "emulator-5554"), "DOWN");
      yield* service.close({ threadId });
      sessionErrors.set(sessionName("thread-1"), "SESSION_NOT_FOUND");
      sessionErrors.delete(sessionName("thread-1", "emulator-5554"));
      yield* service.shutdown({ deviceId: "emulator-5554", platform: "android" });
      yield* service.shutdown({ deviceId: "emulator-5554", platform: "android" });
      expect(calls.filter((call) => call === release("thread-1"))).toHaveLength(3);
      expect(calls.filter((call) => call === release("thread-1", "emulator-5554"))).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("pending cleanup does not revoke a reopened device held by a working thread", () =>
    Effect.gen(function* () {
      const { service, calls, releaseError, busy, releasedNames } = yield* fixture(
        yield* Ref.make<BootRecords>([]),
      );
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);
      yield* agentOpen(service, threadId, "emulator-5554");
      yield* Ref.set(releaseError, "CLEANUP_FAILED");
      yield* service.close({ threadId });
      yield* Ref.set(releaseError, "SESSION_NOT_FOUND");
      yield* agentOpen(service, threadId, "emulator-5554");
      busy.add(threadId);
      calls.length = 0;

      yield* agentOpen(service, thread2, "emulator-5554").pipe(Effect.flip);
      expect(calls).toEqual([]);
      expect(yield* Ref.get(releasedNames)).not.toContain(sessionName("thread-1", "emulator-5554"));

      busy.delete(threadId);
      yield* agentOpen(service, thread2, "emulator-5554");
      expect(calls).toContain(release("thread-1", "emulator-5554"));
      expect(yield* Ref.get(releasedNames)).toContain(sessionName("thread-1", "emulator-5554"));
    }).pipe(Effect.scoped),
  );

  it.effect("an agent opening a device another thread holds but is not using takes it over", () =>
    Effect.gen(function* () {
      const { service, activity, calls } = yield* fixture(yield* Ref.make<BootRecords>([]));
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);
      expect(yield* activity.inUse(thread2)).toEqual([]);
      yield* agentOpen(service, thread2, "emulator-5554");
      expect(calls).toEqual([release("thread-1")]);
      expect(yield* threads(service)).toEqual([thread2]);
    }).pipe(Effect.scoped),
  );

  it.effect("an agent cannot open a device a working thread holds without taking it over", () =>
    Effect.gen(function* () {
      const { service, activity, calls, busy, releasedNames } = yield* fixture(
        yield* Ref.make<BootRecords>([]),
      );
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);
      busy.add(threadId);
      const held = { threadId, hostId: LOCAL_DEVICE_HOST_ID, deviceId: "emulator-5554" };
      expect(yield* activity.inUse(thread2)).toEqual([held]);
      expect(yield* activity.inUse(threadId)).toEqual([]);

      const refused = yield* agentOpen(service, thread2, "emulator-5554").pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "DeviceHeldError",
        hostId: LOCAL_DEVICE_HOST_ID,
        deviceId: "emulator-5554",
        threadIds: [threadId],
      });
      expect(calls).toEqual([]);
      expect(yield* threads(service)).toEqual([threadId]);

      // The holder reopening its own device stays idempotent.
      yield* agentOpen(service, threadId, "emulator-5554");
      expect(yield* threads(service)).toEqual([threadId]);

      yield* agentOpen(service, thread2, "emulator-5554", true);
      expect(calls).toEqual([release("thread-1"), release("thread-1", "emulator-5554")]);
      expect(yield* threads(service)).toEqual([thread2]);
      // The working agent's launcher now reports that its device was handed over.
      expect(yield* Ref.get(releasedNames)).toContain(sessionName("thread-1"));
    }).pipe(Effect.scoped),
  );

  it.effect("refuses every concurrent agent open from a thread, not just the first", () =>
    Effect.gen(function* () {
      const { service, busy } = yield* fixture(yield* Ref.make<BootRecords>([]));
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);
      busy.add(threadId);

      // Two device_open calls from one thread both target the device before either opens it.
      const target = { threadId: thread2, hostId: LOCAL_DEVICE_HOST_ID, deviceId: "emulator-5554" };
      yield* service.agentTarget(target);
      yield* service.agentTarget(target);
      const input = { threadId: thread2, deviceId: "emulator-5554", platform: "android" } as const;
      const open = service.open(input, { agentRequested: true });
      expect(yield* open.pipe(Effect.flip)).toMatchObject({ _tag: "DeviceHeldError" });
      expect(yield* open.pipe(Effect.flip)).toMatchObject({ _tag: "DeviceHeldError" });
      expect(yield* threads(service)).toEqual([threadId]);

      // A Device panel open from the refused thread shares the device.
      yield* service.open(input);
      expect(yield* threads(service)).toEqual([threadId, thread2]);
    }).pipe(Effect.scoped),
  );

  it.effect("a device someone watches is in use for every other thread's agent", () =>
    Effect.gen(function* () {
      const { service, activity, calls } = yield* fixture(yield* Ref.make<BootRecords>([]));
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* activity.watch(LOCAL_DEVICE_HOST_ID, "emulator-5554");
          expect(yield* activity.inUse(thread2)).toEqual([
            { threadId, hostId: LOCAL_DEVICE_HOST_ID, deviceId: "emulator-5554" },
          ]);
          yield* agentOpen(service, thread2, "emulator-5554").pipe(Effect.flip);
          expect(calls).toEqual([]);
          // A panel session elsewhere does not refuse the holder its own device.
          yield* service.open({
            threadId: thread2,
            deviceId: "emulator-5554",
            platform: "android",
          });
          yield* agentOpen(service, threadId, "emulator-5554");
          expect(yield* threads(service)).toEqual([thread2, threadId]);
        }),
      );
      expect(yield* activity.inUse(ThreadId.make("thread-3"))).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("a thread's agent opening a device earlier leaves its Device panel opens shared", () =>
    Effect.gen(function* () {
      const { service, calls, busy } = yield* fixture(yield* Ref.make<BootRecords>([]));
      yield* service.configure({ enabled: true });
      yield* deviceOpenTool(service);
      yield* service.close({ threadId });
      yield* agentOpen(service, thread2, "emulator-5554");
      busy.add(thread2);
      calls.length = 0;

      yield* service.open({ threadId, deviceId: "emulator-5554", platform: "android" });
      expect(calls).toEqual([]);
      expect(yield* threads(service)).toEqual([thread2, threadId]);
    }).pipe(Effect.scoped),
  );

  it.effect("opening a device from the Device panel never takes it from an agent", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* fixture(yield* Ref.make<BootRecords>([]));
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);
      yield* service.open({ threadId: thread2, deviceId: "emulator-5554", platform: "android" });
      expect(calls).toEqual([]);
      expect(yield* threads(service)).toEqual([threadId, thread2]);
    }).pipe(Effect.scoped),
  );

  it.effect("does not hand a connected environment's device to a local agent", () =>
    Effect.gen(function* () {
      const { service, activity, calls, bootElsewhere } = yield* fixture(
        yield* Ref.make<BootRecords>([]),
      );
      bootElsewhere();
      yield* service.configure({ enabled: true });
      const prefix = devicePeerThreadPrefix("agent-environment");
      const peerThread = ThreadId.make(`${prefix}peer-thread`);
      activity.notePeer(prefix, "agent-environment");
      yield* service.open({
        threadId: peerThread,
        deviceId: "emulator-5554",
        platform: "android",
      });
      yield* TestClock.adjust("1 hour");
      expect(yield* activity.inUse(threadId)).toEqual([
        { threadId: peerThread, hostId: LOCAL_DEVICE_HOST_ID, deviceId: "emulator-5554" },
      ]);
      expect((yield* agentOpen(service, threadId, "emulator-5554").pipe(Effect.flip))._tag).toBe(
        "DeviceHeldError",
      );
      // A take-over cannot revoke the other environment's claim, so the device is shared.
      yield* agentOpen(service, threadId, "emulator-5554", true);
      expect(calls).toEqual([]);
      expect(yield* threads(service)).toEqual([peerThread, threadId]);
    }).pipe(Effect.scoped),
  );

  it.effect("a reopen waits for a hand-over in progress instead of being dropped by it", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const { service, calls, releasedNames } = yield* fixture(yield* Ref.make<BootRecords>([]), {
        gate,
      });
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);
      yield* agentOpen(service, threadId, "emulator-5554");

      const takingOver = yield* agentOpen(service, thread2, "emulator-5554").pipe(Effect.forkChild);
      while (calls.length === 0) yield* Effect.yieldNow;
      const reopening = yield* agentOpen(service, threadId, "emulator-5554").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(takingOver);
      yield* Fiber.join(reopening);
      // thread-1 reopened after the hand-over finished, and took the idle device back.
      expect(yield* threads(service)).toEqual([threadId]);
      expect(yield* Ref.get(releasedNames)).not.toContain(sessionName("thread-1", "emulator-5554"));
    }).pipe(Effect.scoped),
  );

  it.effect("released sessions stay refused until device_open hands them out again", () =>
    Effect.gen(function* () {
      const { service, releasedNames } = yield* fixture(yield* Ref.make<BootRecords>([]));
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);
      yield* agentOpen(service, thread2, "emulator-5554");
      // thread-1 lost the device to thread-2, so its session is refused.
      expect(yield* Ref.get(releasedNames)).toEqual([sessionName("thread-1")]);
      // device_open hands thread-1 a session again and takes the device back.
      yield* agentOpen(service, threadId, "emulator-5554");
      expect(yield* Ref.get(releasedNames)).toEqual([
        sessionName("thread-1"),
        sessionName("thread-2", "emulator-5554"),
      ]);
      yield* agentOpen(service, thread2, "emulator-5554");
      expect(yield* Ref.get(releasedNames)).toContain(sessionName("thread-1", "emulator-5554"));
      expect(yield* Ref.get(releasedNames)).not.toContain(sessionName("thread-2", "emulator-5554"));
    }).pipe(Effect.scoped),
  );

  it.effect("an Android device's AVD name and serial share one lock while it boots", () =>
    Effect.gen(function* () {
      const saveGate = yield* Deferred.make<void>();
      const { service, calls, ledgerSaves } = yield* fixture(yield* Ref.make<BootRecords>([]), {
        saveGate,
      });
      yield* service.configure({ enabled: true });
      const opening = yield* agentOpen(service).pipe(Effect.forkChild);
      while (ledgerSaves.count === 0) yield* Effect.yieldNow;
      const stopping = yield* service
        .shutdown({ deviceId: "emulator-5554", platform: "android" })
        .pipe(Effect.forkChild);
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
      expect(calls).not.toContain("shutdown");
      yield* Deferred.succeed(saveGate, undefined);
      yield* Fiber.join(opening);
      yield* Fiber.join(stopping);
      expect(calls).toContain("shutdown");
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
          `release ${agentSessionName("agent-environment:peer-thread", environmentDeviceHostId(OWN_ENVIRONMENT), deviceId)}`;
        expect(calls).toEqual([
          release("thread-1"),
          peerName("emulator-5554"),
          peerName("Pixel_API_35"),
          "shutdown",
        ]);
      }).pipe(Effect.scoped),
  );
});

describe("ended threads", () => {
  it.effect("the sweep releases devices held by archived and deleted threads", () =>
    Effect.gen(function* () {
      const { service, sweep, calls, ended } = yield* fixture(yield* Ref.make<BootRecords>([]));
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);
      const archivedPanel = ThreadId.make("thread-archived");
      const draftPanel = ThreadId.make("thread-draft");
      for (const thread of [archivedPanel, draftPanel])
        yield* service.open({ threadId: thread, deviceId: "emulator-5554", platform: "android" });

      yield* sweep({ shutdownAfter: null, agentAccess: true });
      expect(yield* threads(service)).toEqual([threadId, archivedPanel, draftPanel]);

      ended.set(threadId, "missing");
      ended.set(archivedPanel, "archived");
      // A Device panel session from a thread the projections do not know may be a draft's.
      ended.set(draftPanel, "missing");
      yield* sweep({ shutdownAfter: null, agentAccess: true });
      expect(calls).toEqual([release("thread-1")]);
      expect(yield* threads(service)).toEqual([draftPanel]);
      expect((yield* service.state).devices[0]?.booted).toBe(true);
    }).pipe(Effect.scoped),
  );
});

describe("idle shutdown", () => {
  it.effect(
    "shuts down a device it booted once nobody uses it, releasing the idle hold first",
    () =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<BootRecords>([]);
        const { service, sweep, calls } = yield* fixture(saved);
        yield* service.configure({ enabled: true });
        yield* agentOpen(service);
        expect(yield* Ref.get(saved)).toEqual([pixelRecord]);

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

  it.effect("keeps a device while the thread holding it works or someone watches it", () =>
    Effect.gen(function* () {
      const { service, sweep, activity, busy } = yield* fixture(yield* Ref.make<BootRecords>([]));
      yield* service.configure({ enabled: true });
      yield* agentOpen(service);

      busy.add(threadId);
      yield* TestClock.adjust("30 minutes");
      expect((yield* sweep(withShutdown)).stopped).toEqual([]);
      // The turn just ended, so the idle period starts now.
      busy.delete(threadId);
      yield* TestClock.adjust("9 minutes");
      expect((yield* sweep(withShutdown)).stopped).toEqual([]);

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* activity.watch(LOCAL_DEVICE_HOST_ID, "emulator-5554");
          yield* TestClock.adjust("1 hour");
          expect((yield* sweep(withShutdown)).stopped).toEqual([]);
        }),
      );
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
