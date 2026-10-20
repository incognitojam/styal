import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { DeviceId, LOCAL_DEVICE_HOST_ID, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as DeviceHost from "./DeviceHost.ts";
import * as DeviceIdle from "./DeviceIdle.ts";
import * as DeviceService from "./DeviceService.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as ServerSettings from "../serverSettings.ts";

const deviceId = DeviceId.make("11111111-1111-1111-1111-111111111111");
const threadId = ThreadId.make("startup-project");
const input = { threadId, deviceId, platform: "ios" as const };
const capabilities = [
  "push",
  "storekit",
  "universal-links",
  "icloud",
  "keychain-sync",
  "photos",
  "contacts",
  "calendar",
];

const fixture = Effect.fn("simulatorStartupFixture")(function* (
  options: {
    booted?: boolean;
    gate?: Deferred.Deferred<void>;
    started?: Deferred.Deferred<void>;
    setupFailureAfterExternalBoot?: boolean;
    externalBootDuringSetup?: boolean;
    events?: Array<{ event: string; properties: Record<string, unknown> }>;
  } = {},
) {
  const state = {
    booted: options.booted ?? false,
    disabled: 153,
    mode: "low-memory" as "standard" | "low-memory",
    code: 0,
    captures: 0,
  };
  const calls: string[] = [];
  const ready: DeviceHost.DeviceHostReady = {
    nodePath: "/node",
    hub: { origin: "http://simulator.test" },
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    run: (command, commandArgs) =>
      Effect.gen(function* () {
        const json = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
        if (command === "/node" && options.setupFailureAfterExternalBoot) {
          state.booted = true;
          return { code: 1, stdout: "", stderr: "Download failed" };
        }
        if (command === "/node") {
          if (options.externalBootDuringSetup) state.booted = true;
          return json({ supported: true, installed: true, executable: "/simslim" });
        }
        // Mutations pass SimSlim's global boot limit first.
        const args = commandArgs[0] === "--boot-timeout" ? commandArgs.slice(2) : commandArgs;
        if (command !== "/simslim") return { code: 0, stdout: "", stderr: "" };
        if (args.includes("--list"))
          return json(capabilities.map((id) => ({ id, labels: [`com.apple.test.${id}`] })));
        if (args[0] === "doctor")
          return json({ features: capabilities.map((id) => ({ id, ok: true })) });
        if (args[0] === "status")
          return json({ persistent: true, managedDisabled: state.disabled });
        calls.push(args[0]!);
        if (options.started) yield* Deferred.succeed(options.started, undefined);
        if (options.gate) yield* Deferred.await(options.gate);
        state.booted = true;
        if (state.code === 0) state.disabled = args[0] === "on" ? 153 : 0;
        return { code: state.code, stdout: "", stderr: "" };
      }),
  };
  const host: DeviceHost.DeviceHost["Service"] = {
    id: LOCAL_DEVICE_HOST_ID,
    summary: Effect.succeed({
      id: LOCAL_DEVICE_HOST_ID,
      kind: "local",
      label: "Simulator host",
      platforms: [{ platform: "ios", available: true }],
      hubInstalled: true,
      agentDeviceInstalled: false,
    }),
    platformAvailability: (platform) => Effect.succeed({ platform, available: platform === "ios" }),
    ensureReady: () => Effect.succeed(ready),
    ensureAgentReady: () => Effect.die("unused"),
    current: Effect.succeed(ready),
    stopAgent: Effect.void,
    stop: Effect.void,
  };
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      if (path === "/api/devices")
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            emulators: [],
            simulators: [
              {
                id: deviceId,
                name: "Test iPhone",
                platform: "ios",
                version: "26.5",
                physical: false,
                booted: state.booted,
              },
            ],
          }),
        );
      if (path.endsWith("/shutdown")) {
        state.booted = false;
        calls.push("shutdown");
      }
      if (path === "/api/devices/boot") {
        state.booted = true;
        calls.push("boot");
      }
      if (path.endsWith("/start")) {
        state.captures++;
        calls.push("capture");
      }
      return HttpClientResponse.fromWeb(request, Response.json({ ok: true, id: deviceId }));
    }),
  );
  const inner = yield* DeviceService.makeWithHosts(new Map([[host.id, host]])).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provide(NodeCrypto.layer),
    options.events === undefined
      ? (effect) => effect
      : Effect.provideService(
          AnalyticsService.AnalyticsService,
          AnalyticsService.AnalyticsService.of({
            recordOwners: () => Effect.void,
            record: (event, properties) =>
              Effect.sync(() => {
                options.events?.push({ event, properties: { ...properties } });
              }),
            flush: Effect.void,
          }),
        ),
  );
  const { service, sweep } = yield* DeviceIdle.make(inner, {
    ledger: { load: Effect.succeed([]), save: () => Effect.void },
    releasedSessions: { load: Effect.succeed([]), save: () => Effect.void },
    agentEndpoint: () => Effect.succeed(null),
    environmentId: "test",
    threadStatus: () => Effect.succeed("idle"),
    memoryModeForThread: () => Effect.sync(() => state.mode),
  }).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.provide(NodeCrypto.layer));
  return { service, sweep, state, calls };
});

it.effect(
  "prepares a cold simulator before attaching any viewer and restores on the next start",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.service.open(input);
      expect(f.calls.slice(0, 3)).toEqual(["on", "boot", "capture"]);
      expect(f.state.disabled).toBe(153);
      f.state.mode = "standard";
      yield* f.service.open(input);
      expect(f.calls.filter((call) => call === "on" || call === "off")).toEqual(["on"]);
      yield* f.service.close({ threadId, deviceId, shutdown: true });
      yield* f.service.open(input);
      expect(f.state.disabled).toBe(0);
      expect(f.calls.filter((call) => call === "on" || call === "off")).toEqual(["on", "off"]);
    }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
);

it.effect("does not change a running simulator", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ booted: true });
    yield* f.service.open(input);
    expect(f.calls).toEqual(["capture"]);
  }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
);

it.effect("does not reconfigure a stopped simulator another thread still holds", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.service.open({ ...input, threadId: ThreadId.make("holder"), boot: false });
    yield* f.service.open(input);
    expect(f.calls).toEqual(["boot", "capture"]);
    expect((yield* f.service.state).sessions).toHaveLength(2);
  }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
);

it.effect(
  "starts with a notice and leaves an externally started simulator running when helper setup fails",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture({ setupFailureAfterExternalBoot: true });
      const session = yield* f.service.open(input);
      expect(session.notice).toContain("Could not install the low memory helper.");
      expect(f.state.booted).toBe(true);
      expect(f.calls.filter((call) => call === "on" || call === "off")).toEqual([]);
      expect((yield* f.service.state).sessions.map((entry) => entry.notice)).toEqual([undefined]);
      yield* f.service.close({ threadId, deviceId });
      yield* TestClock.adjust(Duration.minutes(10));
      yield* f.sweep({ shutdownAfter: Duration.minutes(1), agentAccess: false });
      expect(f.state.booted).toBe(true);
    }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
);

it.effect("does not acquire idle-shutdown ownership when another tool boots during setup", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ externalBootDuringSetup: true });
    yield* f.service.open(input);
    expect(f.calls).not.toContain("on");
    yield* f.service.close({ threadId, deviceId });
    yield* TestClock.adjust(Duration.minutes(10));
    yield* f.sweep({ shutdownAfter: Duration.minutes(1), agentAccess: false });
    expect(f.calls).not.toContain("shutdown");
    expect(f.state.booted).toBe(true);
  }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
);

it.effect("returns failed preparation to shutdown without publishing a usable session", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.state.code = 124;
    const error = yield* f.service.open(input).pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "DeviceOperationError", exitCode: 124 });
    expect(f.state.booted).toBe(false);
    expect(f.state.captures).toBe(0);
    expect((yield* f.service.state).sessions).toEqual([]);
    expect((yield* f.service.state).bootingDevices).toEqual([]);
  }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
);

it.effect(
  "serializes simultaneous opens so preparation only happens before the first session",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const f = yield* fixture({ started, gate });
      const first = yield* f.service.open(input).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const second = yield* f.service
        .open({ ...input, threadId: ThreadId.make("second") })
        .pipe(Effect.forkChild);
      expect(f.state.captures).toBe(0);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(f.calls.filter((call) => call === "on" || call === "off")).toEqual(["on"]);
      expect((yield* f.service.state).sessions).toHaveLength(2);
    }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
);

it.effect("reports what each cold start did with the memory mode", () =>
  Effect.gen(function* () {
    const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const f = yield* fixture({ events });
    yield* f.service.open(input);
    yield* f.service.close({ threadId, deviceId, shutdown: true });
    f.state.code = 124;
    yield* f.service.open(input).pipe(Effect.flip);
    expect(
      events
        .filter((entry) => entry.properties.feature === "simulator-memory")
        .map(({ properties }) => ({
          memoryMode: properties.memoryMode,
          memoryResult: properties.memoryResult,
          outcome: properties.outcome,
          failureReason: properties.failureReason,
        })),
    ).toEqual([
      {
        memoryMode: "low-memory",
        memoryResult: "applied",
        outcome: "success",
        failureReason: undefined,
      },
      {
        memoryMode: "low-memory",
        memoryResult: undefined,
        outcome: "failure",
        failureReason: "timeout",
      },
    ]);
  }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
);
