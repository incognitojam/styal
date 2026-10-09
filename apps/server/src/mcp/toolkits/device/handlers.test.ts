import { DeviceHostId, DeviceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import {
  agentDeviceQuickStart,
  agentDeviceTargetArgs,
  devicesOpenInOtherThreads,
  pickDevice,
  pngDimensions,
} from "./handlers.ts";

const device = {
  hostId: "local",
  id: "ABCD-1234",
  platform: "ios" as const,
  name: "iPhone 17 Pro",
  version: "iOS 27.0",
  booted: true,
  physical: false,
};

describe("device tool helpers", () => {
  it("pins agent-device commands to the device by platform-specific flag", () => {
    expect(agentDeviceTargetArgs(device)).toEqual(["--platform", "ios", "--udid", "ABCD-1234"]);
    expect(agentDeviceTargetArgs({ ...device, platform: "android", id: "emulator-5554" })).toEqual([
      "--platform",
      "android",
      "--serial",
      "emulator-5554",
    ]);
  });

  it("writes the quick start around the pinned target", () => {
    const text = agentDeviceQuickStart(device);
    expect(text).toContain("agent-device snapshot -i --platform ios --udid ABCD-1234");
    expect(text).toContain("iPhone 17 Pro (iOS 27.0)");
    expect(text).toContain("XCTest runner");
  });

  it("uses the absolute launcher in every quick-start command", () => {
    const text = agentDeviceQuickStart(
      device,
      ["--session", "thread-1", "--config", "/tmp/host.json"],
      "/tmp/t3 tools/agent-device",
    );
    expect(text).toContain(
      "'/tmp/t3 tools/agent-device' snapshot -i --session thread-1 --config /tmp/host.json",
    );
    expect(text).not.toContain("  agent-device ");
    expect(text).not.toContain("is on PATH");
  });

  it("reads PNG dimensions from the IHDR chunk", () => {
    const png = new Uint8Array(24);
    new DataView(png.buffer).setUint32(0, 0x89504e47);
    new DataView(png.buffer).setUint32(4, 0x0d0a1a0a);
    new DataView(png.buffer).setUint32(12, 0x49484452);
    new DataView(png.buffer).setUint32(16, 1179);
    new DataView(png.buffer).setUint32(20, 2556);
    expect(pngDimensions(png)).toEqual({ width: 1179, height: 2556 });
    expect(pngDimensions(new Uint8Array([1, 2, 3]))).toEqual({ width: 0, height: 0 });
  });
});

describe("choosing a device", () => {
  const local = DeviceHostId.make("local");
  const emulator = (id: string, booted: boolean) => ({
    hostId: local,
    id: DeviceId.make(id),
    platform: "android" as const,
    name: id,
    version: "Android 17.0",
    booted,
    physical: false,
  });
  const session = (threadId: string, deviceId: string) => ({
    threadId,
    hostId: local,
    deviceId: DeviceId.make(deviceId),
  });

  it("lists each device other threads have open once, without this thread's", () => {
    expect(
      devicesOpenInOtherThreads(
        [
          session("thread-a", "emulator-5554"),
          session("thread-b", "emulator-5554"),
          session("thread-me", "emulator-5556"),
        ],
        "thread-me",
      ),
    ).toEqual([{ hostId: local, deviceId: "emulator-5554" }]);
  });

  it.effect("opens a running device no other thread has open", () =>
    Effect.gen(function* () {
      const picked = yield* pickDevice(
        [emulator("emulator-5554", true), emulator("emulator-5556", true)],
        [{ hostId: local, deviceId: DeviceId.make("emulator-5554") }],
        { platform: "android" },
      );
      expect(picked.id).toBe("emulator-5556");
    }),
  );
});
