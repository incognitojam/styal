import type { AdvertisedEndpoint, ServerDirectEndpoint } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { deviceSharingAddresses } from "./device.ts";

const endpoint = (
  httpBaseUrl: string,
  reachability: AdvertisedEndpoint["reachability"],
  source: AdvertisedEndpoint["source"] = "desktop-core",
): AdvertisedEndpoint => ({
  id: httpBaseUrl,
  label: httpBaseUrl,
  provider: { id: "synthetic", label: "Synthetic", kind: "manual", isAddon: false },
  httpBaseUrl,
  wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
  reachability,
  compatibility: { hostedHttpsApp: "unknown", desktopApp: "compatible" },
  source,
  status: "available",
});

const lan: ServerDirectEndpoint = { kind: "lan", httpBaseUrl: "http://192.168.1.20:3773/" };
const tailnet: ServerDirectEndpoint = { kind: "tailnet", httpBaseUrl: "http://100.64.0.20:3773/" };
const served: ServerDirectEndpoint = {
  kind: "tailnet",
  httpBaseUrl: "https://orion.example.ts.net/",
};

it("offers a headless server's reported addresses after the client's own address", () => {
  expect(
    deviceSharingAddresses({
      clientUrl: "https://orion.example.ts.net",
      directEndpoints: [lan, tailnet, served],
      linkUrl: "https://orion.link.example.test/",
    }),
  ).toEqual([
    "https://orion.example.ts.net",
    "http://192.168.1.20:3773",
    "http://100.64.0.20:3773",
    "https://orion.link.example.test",
  ]);
});

it("offers reported addresses when the client reaches the device environment through Link", () => {
  expect(
    deviceSharingAddresses({
      clientUrl: "https://orion.link.example.test",
      directEndpoints: [lan, tailnet],
      linkUrl: "https://orion.link.example.test",
    }),
  ).toEqual([
    "https://orion.link.example.test",
    "http://192.168.1.20:3773",
    "http://100.64.0.20:3773",
  ]);
});

it("puts the desktop default first when the client connects on loopback", () => {
  expect(
    deviceSharingAddresses({
      clientUrl: "http://127.0.0.1:3773",
      directEndpoints: [lan, tailnet],
      desktopEndpoints: [
        endpoint("http://127.0.0.1:3773", "loopback"),
        endpoint("http://192.168.1.20:3773", "lan"),
        endpoint("http://100.64.0.20:3773", "private-network", "desktop-addon"),
      ],
      desktopDefaultEndpoint: endpoint("http://100.64.0.20:3773", "private-network"),
    }),
  ).toEqual(["http://100.64.0.20:3773", "http://192.168.1.20:3773"]);
});

it("keeps a desktop LAN hostname override and custom address after reported addresses", () => {
  // The server reports only numeric interface addresses, so a hostname set
  // with the desktop's LAN host override comes only from the desktop list.
  expect(
    deviceSharingAddresses({
      clientUrl: "http://127.0.0.1:3773",
      directEndpoints: [lan, tailnet],
      desktopEndpoints: [
        endpoint("http://orion.lan.test:3773", "lan"),
        endpoint("http://100.64.0.20:3773", "private-network", "desktop-addon"),
        { ...endpoint("https://devices.test/styal/", "public", "user"), status: "unknown" },
      ],
    }),
  ).toEqual([
    "http://192.168.1.20:3773",
    "http://100.64.0.20:3773",
    "http://orion.lan.test:3773",
    "https://devices.test/styal",
  ]);
});

it("keeps every usable desktop address when the server does not report addresses", () => {
  expect(
    deviceSharingAddresses({
      clientUrl: "http://127.0.0.1:3773",
      directEndpoints: undefined,
      desktopEndpoints: [
        endpoint("http://127.0.0.1:3773", "loopback"),
        endpoint("http://192.168.1.20:3773", "lan"),
        endpoint("http://100.64.0.20:3773", "private-network", "desktop-addon"),
        endpoint("https://orion.example.ts.net", "private-network", "desktop-addon"),
      ],
      desktopDefaultEndpoint: endpoint("https://orion.example.ts.net", "private-network"),
      linkUrl: "https://orion.link.example.test",
    }),
  ).toEqual([
    "https://orion.example.ts.net",
    "http://192.168.1.20:3773",
    "http://100.64.0.20:3773",
    "https://orion.link.example.test",
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
    deviceSharingAddresses({
      clientUrl: "invalid",
      directEndpoints: [
        { kind: "lan", httpBaseUrl: "http://localhost:3773" },
        { kind: "lan", httpBaseUrl: "http://[::1]:3773" },
        ...invalid.map((httpBaseUrl) => ({ kind: "lan" as const, httpBaseUrl })),
      ],
      desktopEndpoints: [
        endpoint("http://192.168.1.20:3773", "loopback", "user"),
        { ...endpoint("https://offline.test", "public", "user"), status: "unavailable" },
      ],
      desktopDefaultEndpoint: {
        ...endpoint("https://orion.example.ts.net", "private-network"),
        status: "unavailable",
      },
      linkUrl: "invalid",
    }),
  ).toBeNull();
  expect(deviceSharingAddresses({ clientUrl: "http://127.0.0.1:41234" })).toBeNull();
  expect(deviceSharingAddresses({ clientUrl: null })).toBeNull();
});

it("retains every usable address and the Link fallback", () => {
  const reported = Array.from({ length: 20 }, (_, index) => ({
    kind: "lan" as const,
    httpBaseUrl: `http://10.0.0.${index + 1}:3773`,
  }));
  expect(
    deviceSharingAddresses({
      clientUrl: null,
      directEndpoints: reported,
      linkUrl: "https://orion.link.example.test",
    }),
  ).toEqual([...reported.map((entry) => entry.httpBaseUrl), "https://orion.link.example.test"]);
});

it("uses the Link address when the server reports no direct addresses", () => {
  expect(
    deviceSharingAddresses({
      clientUrl: "http://127.0.0.1:3773",
      directEndpoints: [],
      linkUrl: "https://orion.link.example.test/",
    }),
  ).toEqual(["https://orion.link.example.test"]);
});
