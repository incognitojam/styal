import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { apnsCredentialsConfig, emailSignInConfig } from "./Config.ts";

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

const resolveEmailSignIn = (stage: string, env: Record<string, string>) =>
  emailSignInConfig(stage).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

describe("emailSignInConfig", () => {
  it.effect("stays off until a sender address is set, including empty CI values", () =>
    Effect.gen(function* () {
      expect(yield* resolveEmailSignIn("prod", {})).toEqual({
        delivery: { kind: "disabled" },
        testSignInCode: undefined,
      });
      expect(
        (yield* resolveEmailSignIn("prod", {
          RELAY_EMAIL_FROM_ADDRESS: "",
          RELAY_EMAIL_DELIVERY: "",
        })).delivery,
      ).toEqual({ kind: "disabled" });
    }),
  );

  it.effect("sends through Cloudflare from the configured address", () =>
    Effect.gen(function* () {
      expect(
        (yield* resolveEmailSignIn("prod", { RELAY_EMAIL_FROM_ADDRESS: "sign-in@example.com" }))
          .delivery,
      ).toEqual({ kind: "cloudflare", fromAddress: "sign-in@example.com", fromName: "styal" });
    }),
  );

  it.effect("refuses log delivery and test codes on prod", () =>
    Effect.gen(function* () {
      yield* Effect.flip(resolveEmailSignIn("prod", { RELAY_EMAIL_DELIVERY: "log" }));
      yield* Effect.flip(resolveEmailSignIn("prod", { RELAY_TEST_SIGN_IN_CODE: "42424242" }));
      expect(
        yield* resolveEmailSignIn("dev", {
          RELAY_EMAIL_DELIVERY: "log",
          RELAY_TEST_SIGN_IN_CODE: "42424242",
        }),
      ).toEqual({ delivery: { kind: "log" }, testSignInCode: "42424242" });
    }),
  );

  it.effect("rejects a test code that is not eight digits", () =>
    Effect.flip(resolveEmailSignIn("dev", { RELAY_TEST_SIGN_IN_CODE: "1234" })),
  );
});
