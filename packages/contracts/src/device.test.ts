import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  DeviceServiceState,
  EasDeviceHostConfig,
  EasDeviceHostConfigs,
  SshDeviceHostConfigs,
  deviceToolInstallMessage,
} from "./device.ts";
import { secretSettingsFields } from "./settings.ts";

import { DeviceConnectEnvironmentInput, EnvironmentDeviceHostConfig } from "./device.ts";

const grant = {
  environmentId: "orion",
  sourceEnvironmentId: "atlas",
  sessionId: "synthetic-session",
  token: "synthetic-token",
};
const decodeConnect = Schema.decodeUnknownSync(DeviceConnectEnvironmentInput);
const decodeHost = Schema.decodeUnknownSync(EnvironmentDeviceHostConfig);

it("decodes legacy sharing requests and saved single-address hosts", () => {
  expect(
    decodeConnect({
      label: "Orion",
      url: "https://orion.test",
      grant,
    }),
  ).toEqual({ label: "Orion", urls: ["https://orion.test"], grant });
  const host = {
    id: `environment-${"a".repeat(24)}`,
    label: "Orion",
    environmentId: "orion",
    sessionId: "synthetic-session",
    url: "https://orion.test",
  };
  expect(decodeHost(host)).toEqual(host);
});

it("rejects empty, malformed, and credential-bearing sharing address lists", () => {
  const decode = decodeConnect;
  for (const urls of [
    [],
    ["file:///device"],
    ["http://user:secret@orion.test"],
    ["http://orion.test?token=synthetic"],
    ["http://orion.test#synthetic"],
  ]) {
    expect(() => decode({ label: "Orion", urls, grant })).toThrow();
  }
  expect(
    decode({ label: "Orion", urls: ["https://orion.test", "http://192.168.1.20:3773"], grant })
      .urls,
  ).toHaveLength(2);
});

describe("device tool install progress", () => {
  it("distinguishes a new install from an upgrade and chooses versions numerically", () => {
    expect(
      deviceToolInstallMessage("device hub", {
        requiredVersion: "0.11.0",
        installedVersions: [],
        runningVersion: null,
      }),
    ).toBe("Installing device hub 0.11.0…");
    expect(
      deviceToolInstallMessage("device hub", {
        requiredVersion: "0.11.0",
        installedVersions: ["0.9.0", "0.10.0"],
        runningVersion: null,
      }),
    ).toBe("Updating device hub from 0.10.0 to 0.11.0…");
  });
});

const decodeSshHosts = Schema.decodeUnknownSync(SshDeviceHostConfigs);
const decodeEas = Schema.decodeUnknownSync(EasDeviceHostConfigs);
const encodeState = Schema.encodeSync(DeviceServiceState);
const decodeState = Schema.decodeUnknownSync(DeviceServiceState);
// The host summary as clients decoded it before EAS hosts existed.
const decodeOlderState = Schema.decodeUnknownSync(
  Schema.Struct({
    hosts: Schema.Array(
      Schema.Struct({ id: Schema.String, kind: Schema.Literals(["local", "ssh"]) }),
    ),
  }),
);

describe("configured device hosts", () => {
  it("reads SSH hosts saved before hosts had a kind, and bounds EAS sessions", () => {
    expect(decodeSshHosts([{ id: "mac", label: "Mac mini", target: "julius@mac" }])).toEqual([
      { kind: "ssh", id: "mac", label: "Mac mini", target: "julius@mac" },
    ]);
    expect(decodeEas([{ kind: "eas", id: "eas", label: "EAS Simulator" }])).toEqual([
      {
        kind: "eas",
        id: "eas",
        label: "EAS Simulator",
        accessToken: "",
        maxSessionMinutes: 30,
        idleMinutes: 10,
        maxConcurrentSessions: 2,
      },
    ]);
    expect(() =>
      decodeEas([{ kind: "eas", id: "eas", label: "EAS", maxSessionMinutes: 600 }]),
    ).toThrow();
    // The default idle limit of 10 is not smaller than a session limit of 10.
    expect(() =>
      decodeEas([{ kind: "eas", id: "eas", label: "EAS", maxSessionMinutes: 10 }]),
    ).toThrow();
  });

  it("marks the EAS access token as a secret setting", () => {
    expect(secretSettingsFields(EasDeviceHostConfig)).toEqual(["accessToken"]);
  });
});

describe("device state for clients from before EAS hosts", () => {
  const summary = {
    label: "Host",
    platforms: [],
    hubInstalled: true,
    agentDeviceInstalled: true,
  };
  const state = {
    hosts: [
      { ...summary, id: "local", kind: "local" as const },
      { ...summary, id: "eas", kind: "eas" as const },
    ],
    hostStatus: "ready" as const,
    hostStatuses: {},
    devices: [],
    sessions: [],
    onboardingCompleted: true,
    agentAccessEnabled: true,
    hubBasePath: "/api/device-hub",
    revision: 1,
  };

  it("sends EAS hosts where an older client does not look, and reads them back", () => {
    const wire = encodeState(state);
    expect(decodeOlderState(wire).hosts.map((host) => host.id)).toEqual(["local"]);
    expect(decodeState(wire).hosts).toEqual(state.hosts);
  });
});
