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

const screenLit: ServerSettings = { ...enabled, keepPhysicalAndroidScreensOff: false };

describe("PhysicalAndroidHold", () => {
  it("holds only local physical Android devices with a session", () => {
    expect([
      ...PhysicalAndroidHold.heldDevices(enabled, state([session(PHONE.id), session(EMULATOR.id)])),
    ]).toEqual([[PHONE.id, { screenOff: true }]]);
    expect([...PhysicalAndroidHold.heldDevices(screenLit, state([session(PHONE.id)]))]).toEqual([
      [PHONE.id, { screenOff: false }],
    ]);
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

  it.effect("keeps a held phone awake with its screen on when screen-off is turned off", () =>
    Effect.gen(function* () {
      const { events, settings, states, fiber } = yield* run();
      yield* Queue.offer(settings, enabled);
      yield* Queue.offer(states, state([session(PHONE.id)]));
      expect(yield* Queue.take(events)).toBe(`start ${PHONE.id} dark`);

      yield* Queue.offer(settings, screenLit);
      expect(yield* Queue.take(events)).toBe(`stop ${PHONE.id} dark`);
      expect(yield* Queue.take(events)).toBe(`start ${PHONE.id} lit`);
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
