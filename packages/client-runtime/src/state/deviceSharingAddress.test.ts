import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { deviceSharingAddresses } from "./device.ts";

const endpoint = (
  httpBaseUrl: string,
  reachability: AdvertisedEndpoint["reachability"],
): AdvertisedEndpoint => ({
  id: httpBaseUrl,
  label: httpBaseUrl,
  provider: { id: "synthetic", label: "Synthetic", kind: "manual", isAddon: false },
  httpBaseUrl,
  wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
  reachability,
  compatibility: { hostedHttpsApp: "unknown", desktopApp: "compatible" },
  source: "desktop-core",
  status: "available",
});

it("collects client, preferred, and advertised addresses in order without duplicates", () => {
  const lan = endpoint("http://192.168.1.20:3773/", "lan");
  const tailnet = endpoint("https://orion.example.ts.net/", "private-network");
  expect(deviceSharingAddresses("https://orion.example.ts.net", [lan, tailnet], lan)).toEqual([
    "https://orion.example.ts.net",
    "http://192.168.1.20:3773",
  ]);
});

it("uses every desktop network address when the client connects on loopback", () => {
  const lan = endpoint("http://192.168.1.20:3773", "lan");
  const tailnet = endpoint("http://100.64.0.20:3773", "private-network");
  expect(deviceSharingAddresses("http://127.0.0.1:3773", [lan, tailnet], tailnet)).toEqual([
    tailnet.httpBaseUrl,
    lan.httpBaseUrl,
  ]);
});

it("excludes unavailable, loopback, and malformed addresses", () => {
  const invalid = [
    "file:///device",
    "http://user:password@orion.test",
    "http://orion.test?token=synthetic",
    "http://orion.test#synthetic",
    "invalid",
  ];
  expect(
    deviceSharingAddresses("invalid", [
      endpoint("http://localhost:3773", "lan"),
      endpoint("http://[::1]:3773", "lan"),
      endpoint("http://192.168.1.20:3773", "loopback"),
      { ...endpoint("https://offline.test", "public"), status: "unavailable" },
      ...invalid.map((url) => endpoint(url, "public")),
    ]),
  ).toBeNull();
  expect(deviceSharingAddresses("http://127.0.0.1:41234")).toBeNull();
  expect(deviceSharingAddresses(null)).toBeNull();
});

it("retains a custom proxy's path and unknown-status endpoints", () => {
  expect(
    deviceSharingAddresses(null, [
      { ...endpoint("https://devices.test/styal/", "public"), status: "unknown" },
    ]),
  ).toEqual(["https://devices.test/styal"]);
});

it("includes a discovered styal Link address when the client uses desktop loopback", () => {
  expect(
    deviceSharingAddresses("http://127.0.0.1:3773", [], null, ["https://orion.link.example.test/"]),
  ).toEqual(["https://orion.link.example.test"]);
});

it("retains every usable advertised address and the Link fallback", () => {
  const addresses = Array.from({ length: 20 }, (_, index) =>
    endpoint(`https://device-${index}.test`, "public"),
  );
  const result = deviceSharingAddresses(null, addresses, null, ["https://orion.link.example.test"]);
  expect(result).toEqual([
    ...addresses.map((entry) => entry.httpBaseUrl),
    "https://orion.link.example.test",
  ]);
});
