import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { apnsCredentialsConfig, managedEndpointCleanupModeConfig } from "./Config.ts";

const resolve = (env: Record<string, string>) =>
  apnsCredentialsConfig.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))));

const fullEnv = {
  APNS_ENVIRONMENT: "production",
  APNS_TEAM_ID: "team-id",
  APNS_KEY_ID: "key-id",
  APNS_BUNDLE_ID: "com.t3tools.t3code",
  APNS_PRIVATE_KEY: "pem-private-key",
};

describe("apnsCredentialsConfig", () => {
  it.effect("disables push delivery when no APNs value is set", () =>
    Effect.gen(function* () {
      expect(yield* resolve({})).toBeNull();
    }),
  );

  it.effect("treats empty strings as unset", () =>
    Effect.gen(function* () {
      // Deploy CI forwards unset GitHub variables as empty env entries.
      expect(
        yield* resolve({
          APNS_ENVIRONMENT: "",
          APNS_TEAM_ID: "",
          APNS_KEY_ID: "",
          APNS_BUNDLE_ID: "",
          APNS_PRIVATE_KEY: "",
        }),
      ).toBeNull();
    }),
  );

  it.effect("resolves the full credential group", () =>
    Effect.gen(function* () {
      const credentials = yield* resolve(fullEnv);
      expect(credentials).not.toBeNull();
      expect(credentials?.environment).toBe("production");
      expect(credentials?.teamId).toBe("team-id");
      expect(credentials?.keyId).toBe("key-id");
      expect(credentials?.bundleId).toBe("com.t3tools.t3code");
      expect(Redacted.value(credentials!.privateKey)).toBe("pem-private-key");
    }),
  );

  it.effect("fails a partial group and lists the missing names", () =>
    Effect.gen(function* () {
      const error = yield* resolve({ APNS_TEAM_ID: "team-id", APNS_KEY_ID: "key-id" }).pipe(
        Effect.flip,
      );
      expect(error._tag).toBe("ConfigError");
      expect(error.message).toContain(
        "Missing: APNS_ENVIRONMENT, APNS_BUNDLE_ID, APNS_PRIVATE_KEY",
      );
    }),
  );

  it.effect("counts an empty value in an otherwise full group as missing", () =>
    Effect.gen(function* () {
      const error = yield* resolve({ ...fullEnv, APNS_PRIVATE_KEY: "" }).pipe(Effect.flip);
      expect(error._tag).toBe("ConfigError");
      expect(error.message).toContain("Missing: APNS_PRIVATE_KEY");
    }),
  );

  it.effect("rejects an invalid APNs environment", () =>
    Effect.gen(function* () {
      const error = yield* resolve({ ...fullEnv, APNS_ENVIRONMENT: "staging" }).pipe(Effect.flip);
      expect(error._tag).toBe("ConfigError");
    }),
  );
});

it.effect.each([
  { name: "missing", env: {}, expected: "off" },
  { name: "empty", env: { RELAY_TUNNEL_CLEANUP_MODE: "" }, expected: "off" },
  { name: "whitespace", env: { RELAY_TUNNEL_CLEANUP_MODE: "  \t" }, expected: "off" },
  { name: "off", env: { RELAY_TUNNEL_CLEANUP_MODE: "off" }, expected: "off" },
  {
    name: "dry-run",
    env: { RELAY_TUNNEL_CLEANUP_MODE: "dry-run" },
    expected: "dry-run",
  },
  { name: "enabled", env: { RELAY_TUNNEL_CLEANUP_MODE: "enabled" }, expected: "enabled" },
] as const)("loads $name cleanup mode as $expected", ({ env, expected }) =>
  Effect.gen(function* () {
    const provider = ConfigProvider.fromEnv({ env });
    expect(yield* managedEndpointCleanupModeConfig.parse(provider)).toBe(expected);
  }),
);

it.effect("rejects an invalid cleanup mode", () =>
  Effect.gen(function* () {
    const provider = ConfigProvider.fromEnv({
      env: { RELAY_TUNNEL_CLEANUP_MODE: "delete-everything" },
    });
    const error = yield* Effect.flip(managedEndpointCleanupModeConfig.parse(provider));

    expect(error._tag).toBe("ConfigError");
    expect(error.message).toContain('Expected "off" | "dry-run" | "enabled"');
  }),
);
