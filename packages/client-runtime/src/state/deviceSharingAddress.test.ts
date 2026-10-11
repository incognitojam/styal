import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { isClientOnlyDeviceAddress, suggestDeviceSharingAddress } from "./device.ts";

const endpoint = (
  id: string,
  httpBaseUrl: string,
  reachability: AdvertisedEndpoint["reachability"],
  extra: Partial<AdvertisedEndpoint> = {},
): AdvertisedEndpoint => ({
  id,
  label: id,
  provider: { id: "synthetic", label: "Synthetic", kind: "manual", isAddon: false },
  httpBaseUrl,
  wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
  reachability,
  compatibility: { hostedHttpsApp: "unknown", desktopApp: "compatible" },
  source: "desktop-core",
  status: "available",
  ...extra,
});

it("keeps an address the client reaches over the network", () => {
  expect(
    suggestDeviceSharingAddress("https://orion.example.ts.net", [
      endpoint("lan", "http://192.168.1.20:3773", "lan"),
    ]),
  ).toBe("https://orion.example.ts.net");
});

it("replaces a loopback address with the device environment's advertised network address", () => {
  const endpoints = [
    endpoint("loopback", "http://127.0.0.1:3773", "loopback"),
    endpoint("offline", "http://192.168.1.30:3773", "lan", { status: "unavailable" }),
    endpoint("lan", "http://192.168.1.20:3773", "lan"),
    endpoint("tailnet", "https://orion.example.ts.net", "private-network", { isDefault: true }),
  ];
  expect(suggestDeviceSharingAddress("http://127.0.0.1:3773", endpoints)).toBe(
    "https://orion.example.ts.net",
  );
  expect(suggestDeviceSharingAddress("http://127.0.0.1:3773", endpoints.slice(0, 3))).toBe(
    "http://192.168.1.20:3773",
  );
});

it("falls back to the client's loopback address when nothing else is known", () => {
  // SSH tunnels and remote servers reached over loopback advertise nothing to the client.
  expect(suggestDeviceSharingAddress("http://127.0.0.1:41234")).toBe("http://127.0.0.1:41234");
  expect(isClientOnlyDeviceAddress("http://127.0.0.1:41234")).toBe(true);
  expect(isClientOnlyDeviceAddress("http://localhost:3773")).toBe(true);
  expect(isClientOnlyDeviceAddress("http://192.168.1.20:3773")).toBe(false);
  expect(isClientOnlyDeviceAddress("not a url")).toBe(false);
});
