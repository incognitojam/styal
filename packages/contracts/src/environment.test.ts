import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("preserves npm identity while accepting descriptors from older servers", () => {
    expect(decodeDescriptor(descriptor).serverPackageName).toBeUndefined();
    expect(
      decodeDescriptor({ ...descriptor, serverPackageName: "@styal/cli" }).serverPackageName,
    ).toBe("@styal/cli");
  });

  it("accepts public descriptors without installation or host details and legacy installation metadata", () => {
    expect(decodeDescriptor(descriptor).platform).toEqual({ os: "darwin", arch: "arm64" });
    expect(decodeDescriptor(descriptor).capabilities.serverInstallation).toBeUndefined();
    for (const installation of [
      { kind: "npx" },
      { kind: "npm-global", prefix: "/opt/node" },
      { kind: "t3-launcher", launcher: "/opt/bin/t3", baseDir: "/data/t3" },
    ]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toEqual(installation);
    }
    const spaced = { kind: "t3-launcher", launcher: "/opt/bin/t3 ", baseDir: " /data/t3 " };
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, serverInstallation: spaced },
      }).capabilities.serverInstallation,
    ).toEqual(spaced);
    for (const installation of [
      { kind: "future-manager" },
      { kind: "npm-global" },
      { kind: "t3-launcher", launcher: "t3" },
    ]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toBeUndefined();
    }
  });
});
