import type { DeviceSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupDevices } from "./deviceGroups";

const device = (overrides: Partial<DeviceSummary> & Pick<DeviceSummary, "id">): DeviceSummary => ({
  hostId: "local",
  name: overrides.id,
  platform: "android",
  version: "Android 17.0",
  booted: false,
  physical: false,
  ...overrides,
});

describe("groupDevices", () => {
  it("lists plugged-in devices apart from simulators and emulators on each platform", () => {
    const groups = groupDevices([
      device({ id: "pixel_7_api_37" }),
      device({ id: "Pixel 3 XL", physical: true, booted: true }),
      device({ id: "iPhone 17 Pro", platform: "ios" }),
    ]);
    expect(groups.map((group) => [group.label, group.devices.map(({ id }) => id)])).toEqual([
      ["iOS Simulators", ["iPhone 17 Pro"]],
      ["Android Devices", ["Pixel 3 XL"]],
      ["Android Emulators", ["pixel_7_api_37"]],
    ]);
  });

  it("puts running devices first, then sorts by name", () => {
    const [group] = groupDevices([
      device({ id: "b" }),
      device({ id: "c", booted: true }),
      device({ id: "a" }),
    ]);
    expect(group?.devices.map(({ id }) => id)).toEqual(["c", "a", "b"]);
  });
});
