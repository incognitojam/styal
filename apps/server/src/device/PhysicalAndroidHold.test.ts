import * as NodeNet from "node:net";

import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type DeviceServiceState,
  type DeviceSession,
  type DeviceSummary,
  LOCAL_DEVICE_HOST_ID,
  type ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Sink from "effect/Sink";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type * as DeviceHost from "./DeviceHost.ts";
import * as PhysicalAndroidHold from "./PhysicalAndroidHold.ts";

const device = (id: string, physical: boolean): DeviceSummary => ({
  hostId: LOCAL_DEVICE_HOST_ID,
  id,
  platform: "android",
  name: id,
  version: "16",
  booted: true,
  physical,
});
const session = (deviceId: string): DeviceSession => ({
  threadId: ThreadId.make("thread-1"),
  hostId: LOCAL_DEVICE_HOST_ID,
  deviceId,
  platform: "android",
  openedAt: "2026-10-28T00:00:00.000Z",
});
const PHONE = device("R5CT10ABCDE", true);
const EMULATOR = device("emulator-5554", false);
const enabled: ServerSettings = { ...DEFAULT_SERVER_SETTINGS, enableDeviceSupport: true };
const state = (sessions: ReadonlyArray<DeviceSession>) =>
  ({ devices: [PHONE, EMULATOR], sessions }) as unknown as DeviceServiceState;

/** A local host whose device holds report when they start and stop, with their screen option. */
const fakeHost = Effect.fn("fakeHost")(function* (holdEndsAfterStart = false) {
  const events = yield* Queue.unbounded<string>();
  const ready: DeviceHost.DeviceHostReady = {
    devices: {
      list: Effect.die("Typed environment operations are required"),
      boot: () => Effect.die("Typed environment operations are required"),
      attach: () => Effect.die("Typed environment operations are required"),
      shutdown: () => Effect.die("Typed environment operations are required"),
      screenshot: () => Effect.die("Typed environment operations are required"),
    },
    hub: { origin: "http://127.0.0.1:1" },
    nodePath: "node",
    run: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    holdPhysicalDevice: (serial, options) => {
      const label = `${serial} ${options.screenOff ? "dark" : "lit"}`;
      return Effect.acquireRelease(Queue.offer(events, `start ${label}`), () =>
        Queue.offer(events, `stop ${label}`),
      ).pipe(Effect.andThen(holdEndsAfterStart ? Effect.void : Effect.never));
    },
  };
  const host = { current: Effect.succeed(ready) } as unknown as DeviceHost.DeviceHost["Service"];
  return { host, events };
});

const run = Effect.fn("run")(function* (holdEndsAfterStart = false) {
  const { host, events } = yield* fakeHost(holdEndsAfterStart);
  const settings = yield* Queue.unbounded<ServerSettings>();
  const states = yield* Queue.unbounded<DeviceServiceState>();
  const fiber = yield* Effect.forkChild(
    PhysicalAndroidHold.holdHeldDevices({
      host,
      settings: Stream.fromQueue(settings),
      states: Stream.fromQueue(states),
    }),
  );
  return { events, settings, states, fiber };
});

const disabled: ServerSettings = { ...enabled, enableDeviceSupport: false };

describe("PhysicalAndroidHold", () => {
  it.live(
    "sends screen-off control and cleans up the socket, helper and adb forward on release",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const received = yield* Deferred.make<ReadonlyArray<number>>();
          const disconnected = yield* Deferred.make<void>();
          const server = NodeNet.createServer((socket) => {
            socket.write(Uint8Array.of(0));
            socket.once("data", (data) => Deferred.doneUnsafe(received, Effect.succeed([...data])));
            socket.once("close", () => Deferred.doneUnsafe(disconnected, Effect.void));
          });
          yield* Effect.acquireRelease(
            Effect.promise(
              () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
            ),
            () =>
              Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
          );
          const address = server.address() as NodeNet.AddressInfo;
          const commands: ReadonlyArray<string>[] = [];
          const stopped = yield* Deferred.make<void>();
          const spawner = ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              if (command._tag === "StandardCommand") {
                expect(command.args).toContain("stay_awake=true");
                expect(command.args).toContain("cleanup=true");
                expect(command.args).toContain("video=false");
                expect(command.args).toContain("audio=false");
              }
              yield* Effect.addFinalizer(() => Deferred.succeed(stopped, undefined));
              return ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(123),
                stdout: Stream.empty,
                stderr: Stream.empty,
                all: Stream.empty,
                exitCode: Effect.never,
                isRunning: Effect.succeed(true),
                kill: () => Effect.void,
                stdin: Sink.drain,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
                unref: Effect.succeed(Effect.void),
              });
            }),
          );
          const fiber = yield* PhysicalAndroidHold.holdDevice(
            {
              hostId: LOCAL_DEVICE_HOST_ID,
              adb: "synthetic-adb",
              env: {},
              server: { path: "synthetic-scrcpy-server", version: "3.3.4" },
              run: (_command, args) =>
                Effect.sync(() => {
                  commands.push(args);
                  return { stdout: String(address.port), stderr: "", code: 0 };
                }),
            },
            PHONE.id,
            { screenOff: true },
          ).pipe(
            Effect.scoped,
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.forkChild,
          );
          expect(yield* Deferred.await(received)).toEqual([10, 0]);
          yield* Fiber.interrupt(fiber);
          yield* Deferred.await(disconnected);
          yield* Deferred.await(stopped);
          expect(commands.at(-1)).toEqual([
            "-s",
            PHONE.id,
            "forward",
            "--remove",
            `tcp:${address.port}`,
          ]);
        }),
      ),
  );
  it("holds only local physical Android devices with a session", () => {
    expect([
      ...PhysicalAndroidHold.heldDevices(enabled, state([session(PHONE.id), session(EMULATOR.id)])),
    ]).toEqual([[PHONE.id, { screenOff: true }]]);
    expect(PhysicalAndroidHold.heldDevices(enabled, state([])).size).toBe(0);
    expect(
      PhysicalAndroidHold.heldDevices(
        { ...enabled, enableDeviceSupport: false },
        state([session(PHONE.id)]),
      ).size,
    ).toBe(0);
  });

  it.effect("holds a phone while it has a session and releases it after", () =>
    Effect.gen(function* () {
      const { events, settings, states, fiber } = yield* run();
      yield* Queue.offer(settings, enabled);
      yield* Queue.offer(states, state([session(PHONE.id), session(EMULATOR.id)]));
      expect(yield* Queue.take(events)).toBe(`start ${PHONE.id} dark`);

      yield* Queue.offer(states, state([session(EMULATOR.id)]));
      expect(yield* Queue.take(events)).toBe(`stop ${PHONE.id} dark`);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("releases the phone when device support is turned off", () =>
    Effect.gen(function* () {
      const { events, settings, states, fiber } = yield* run();
      yield* Queue.offer(settings, enabled);
      yield* Queue.offer(states, state([session(PHONE.id)]));
      expect(yield* Queue.take(events)).toBe(`start ${PHONE.id} dark`);

      yield* Queue.offer(settings, disabled);
      expect(yield* Queue.take(events)).toBe(`stop ${PHONE.id} dark`);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("starts the hold again when a phone reconnects", () =>
    Effect.gen(function* () {
      const { events, settings, states, fiber } = yield* run(true);
      yield* Queue.offer(settings, enabled);
      yield* Queue.offer(states, state([session(PHONE.id)]));
      expect(yield* Queue.take(events)).toBe(`start ${PHONE.id} dark`);
      expect(yield* Queue.take(events)).toBe(`stop ${PHONE.id} dark`);

      const waiter = yield* Effect.forkChild(Queue.take(events));
      yield* TestClock.adjust("15 seconds");
      expect(yield* Fiber.join(waiter)).toBe(`start ${PHONE.id} dark`);
      yield* Fiber.interrupt(fiber);
    }),
  );
});
