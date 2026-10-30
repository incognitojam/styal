import type { DevicePlatform, DeviceSummary } from "@t3tools/contracts";

export interface DeviceGroup {
  readonly key: string;
  readonly label: string;
  readonly devices: ReadonlyArray<DeviceSummary>;
}

const GROUPS: ReadonlyArray<{ platform: DevicePlatform; physical: boolean; label: string }> = [
  { platform: "ios", physical: true, label: "iOS Devices" },
  { platform: "ios", physical: false, label: "iOS Simulators" },
  { platform: "android", physical: true, label: "Android Devices" },
  { platform: "android", physical: false, label: "Android Emulators" },
];

/** Plugged-in devices list apart from simulators and emulators: they cannot be started or powered off. */
export function groupDevices(devices: ReadonlyArray<DeviceSummary>): DeviceGroup[] {
  return GROUPS.flatMap(({ platform, physical, label }) => {
    const members = devices
      .filter((device) => device.platform === platform && device.physical === physical)
      .toSorted((a, b) => Number(b.booted) - Number(a.booted) || a.name.localeCompare(b.name));
    return members.length > 0 ? [{ key: `${platform}:${physical}`, label, devices: members }] : [];
  });
}
