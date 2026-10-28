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
import * as PhysicalScreenOff from "./PhysicalScreenOff.ts";

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

/** A local host whose display holds report when they start and stop. */
const fakeHost = Effect.fn("fakeHost")(function* (holdEndsAfterStart = false) {
  const events = yield* Queue.unbounded<string>();
  const ready: DeviceHost.DeviceHostReady = {
    hub: { origin: "http://127.0.0.1:1" },
    nodePath: "node",
    run: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    holdDisplayOff: (serial) =>
      Effect.acquireRelease(Queue.offer(events, `start ${serial}`), () =>
        Queue.offer(events, `stop ${serial}`),
      ).pipe(Effect.andThen(holdEndsAfterStart ? Effect.void : Effect.never)),
  };
  const host = { current: Effect.succeed(ready) } as unknown as DeviceHost.DeviceHost["Service"];
  return { host, events };
});

const run = Effect.fn("run")(function* (holdEndsAfterStart = false) {
  const { host, events } = yield* fakeHost(holdEndsAfterStart);
  const settings = yield* Queue.unbounded<ServerSettings>();
  const states = yield* Queue.unbounded<DeviceServiceState>();
  const fiber = yield* Effect.forkChild(
    PhysicalScreenOff.keepScreensOff({
      host,
      settings: Stream.fromQueue(settings),
      states: Stream.fromQueue(states),
    }),
  );
  return { events, settings, states, fiber };
});

describe("PhysicalScreenOff", () => {
  it("targets only local physical Android devices with a session", () => {
    expect([
      ...PhysicalScreenOff.screenOffTargets(
        enabled,
        state([session(PHONE.id), session(EMULATOR.id)]),
      ),
    ]).toEqual([PHONE.id]);
    expect(PhysicalScreenOff.screenOffTargets(enabled, state([])).size).toBe(0);
    expect(
      PhysicalScreenOff.screenOffTargets(
        { ...enabled, keepPhysicalAndroidScreensOff: false },
        state([session(PHONE.id)]),
      ).size,
    ).toBe(0);
    expect(
      PhysicalScreenOff.screenOffTargets(
        { ...enabled, enableDeviceSupport: false },
        state([session(PHONE.id)]),
      ).size,
    ).toBe(0);
  });

  it.effect("holds a phone's display off while it has a session and releases it after", () =>
    Effect.gen(function* () {
      const { events, settings, states, fiber } = yield* run();
      yield* Queue.offer(settings, enabled);
      yield* Queue.offer(states, state([session(PHONE.id), session(EMULATOR.id)]));
      expect(yield* Queue.take(events)).toBe(`start ${PHONE.id}`);

      yield* Queue.offer(states, state([session(EMULATOR.id)]));
      expect(yield* Queue.take(events)).toBe(`stop ${PHONE.id}`);

      yield* Queue.offer(states, state([session(PHONE.id)]));
      expect(yield* Queue.take(events)).toBe(`start ${PHONE.id}`);

      yield* Queue.offer(settings, { ...enabled, keepPhysicalAndroidScreensOff: false });
      expect(yield* Queue.take(events)).toBe(`stop ${PHONE.id}`);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("starts the hold again when a phone reconnects", () =>
    Effect.gen(function* () {
      const { events, settings, states, fiber } = yield* run(true);
      yield* Queue.offer(settings, enabled);
      yield* Queue.offer(states, state([session(PHONE.id)]));
      expect(yield* Queue.take(events)).toBe(`start ${PHONE.id}`);
      expect(yield* Queue.take(events)).toBe(`stop ${PHONE.id}`);

      const waiter = yield* Effect.forkChild(Queue.take(events));
      yield* TestClock.adjust("15 seconds");
      expect(yield* Fiber.join(waiter)).toBe(`start ${PHONE.id}`);
      yield* Fiber.interrupt(fiber);
    }),
  );
});
