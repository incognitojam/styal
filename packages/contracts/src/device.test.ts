import { describe, expect, it } from "@effect/vitest";
import { deviceToolInstallMessage } from "./device.ts";
import { DeviceConnectEnvironmentInput, EnvironmentDeviceHostConfig } from "./device.ts";
import * as Schema from "effect/Schema";

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
