import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const ApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type ApnsEnvironment = typeof ApnsEnvironment.Type;

export const ManagedEndpointCleanupMode = Schema.Literals(["off", "dry-run", "enabled"]);
export type ManagedEndpointCleanupMode = typeof ManagedEndpointCleanupMode.Type;
const decodeManagedEndpointCleanupMode = Schema.decodeUnknownEffect(ManagedEndpointCleanupMode);

const RELAY_TUNNEL_CLEANUP_MODE = "RELAY_TUNNEL_CLEANUP_MODE";
/** Separate switch for tunnels whose host never registered recovery. */
const RELAY_LEGACY_TUNNEL_CLEANUP_MODE = "RELAY_LEGACY_TUNNEL_CLEANUP_MODE";

const cleanupModeConfig = (name: string) =>
  Config.String(name).pipe(
    Config.withDefault("off"),
    Config.map((value) => value.trim() || "off"),
    Config.mapEffect((value) =>
      decodeManagedEndpointCleanupMode(value).pipe(
        Effect.mapError((error) => new Config.ConfigError(error)),
      ),
    ),
  );

export const managedEndpointCleanupModeConfig = cleanupModeConfig(RELAY_TUNNEL_CLEANUP_MODE);
export const legacyManagedEndpointCleanupModeConfig = cleanupModeConfig(
  RELAY_LEGACY_TUNNEL_CLEANUP_MODE,
);

/**
 * Overrides the 7-day legacy grace period, in minutes, so the disposable
 * canary stage can exercise legacy cleanup. Ignored on the prod stage.
 */
const RELAY_LEGACY_TUNNEL_GRACE_MINUTES = "RELAY_LEGACY_TUNNEL_GRACE_MINUTES";

// A zero or negative override would be ignored at runtime, silently leaving
// the canary on the 7-day grace period, so reject it when the deploy reads it.
export const legacyTunnelGraceMinutesConfig = Config.option(
  Config.schema(
    Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0))),
    RELAY_LEGACY_TUNNEL_GRACE_MINUTES,
  ),
);

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly bundleId: string;
  readonly environment: ApnsEnvironment;
}

export class RelayConfiguration extends Context.Service<
  RelayConfiguration,
  {
    readonly relayIssuer: string;
    /**
     * `null` when the relay is deployed without APNs credentials. The worker
     * boundary then binds the disabled ApnsClient, so push delivery is off
     * while the rest of the pipeline runs unchanged.
     */
    readonly apns: ApnsCredentials | null;
    readonly fcmServiceAccount?: Redacted.Redacted<string>;
    readonly clerkSecretKey: Redacted.Redacted<string>;
    readonly clerkPublishableKey: string;
    readonly clerkJwtAudience: string;
    /** Keys the stored hashes of email sign-in codes. */
    readonly signInCodeSecret: Redacted.Redacted<string>;
    /** Non-production only: the code test accounts sign in with. */
    readonly testSignInCode?: string;
    readonly apnsDeliveryJobSigningSecret: Redacted.Redacted<string>;
    readonly cloudMintPrivateKey: Redacted.Redacted<string>;
    readonly cloudMintPublicKey: string;
    readonly managedEndpointBaseDomain: string | undefined;
    readonly managedEndpointNamespace: string | undefined;
    readonly managedEndpointCleanupMode?: ManagedEndpointCleanupMode;
    readonly legacyManagedEndpointCleanupMode?: ManagedEndpointCleanupMode;
    /** Canary-only override of the legacy grace period; ignored on prod. */
    readonly legacyTunnelGraceMinutes?: number;
  }
>()("t3code-relay/Config/RelayConfiguration") {}

export const make = (configuration: RelayConfiguration["Service"]) =>
  RelayConfiguration.of(configuration);

export const layer = (configuration: RelayConfiguration["Service"]) =>
  Layer.succeed(RelayConfiguration, make(configuration));

/**
 * Inert stand-in used where a `null` `apns` config still has to satisfy the
 * `ApnsCredentials` type (see `credentialsForTarget`). Only ever handed to the
 * disabled ApnsClient, which drops sends without reading credentials.
 */
export const disabledApnsCredentials: ApnsCredentials = {
  environment: "sandbox",
  teamId: "",
  keyId: "",
  bundleId: "",
  privateKey: Redacted.make(""),
};

const apnsConfigNames = [
  "APNS_ENVIRONMENT",
  "APNS_TEAM_ID",
  "APNS_KEY_ID",
  "APNS_BUNDLE_ID",
  "APNS_PRIVATE_KEY",
] as const;

const optionalString = (name: (typeof apnsConfigNames)[number]) =>
  Config.String(name).pipe(Config.withDefault(""));

/**
 * Resolves the APNs credential group all-or-nothing. CI passes unset GitHub
 * variables through as empty strings, so empty counts as unset. All five
 * unset yields `null` (push delivery disabled); a partial group fails config
 * resolution loudly, listing the missing names.
 */
export const apnsCredentialsConfig: Effect.Effect<ApnsCredentials | null, Config.ConfigError> =
  Effect.gen(function* () {
    const environment = yield* optionalString("APNS_ENVIRONMENT");
    const teamId = yield* optionalString("APNS_TEAM_ID");
    const keyId = yield* optionalString("APNS_KEY_ID");
    const bundleId = yield* optionalString("APNS_BUNDLE_ID");
    const privateKey = yield* Config.Redacted("APNS_PRIVATE_KEY").pipe(
      Config.withDefault(Redacted.make("")),
    );

    const present: Record<(typeof apnsConfigNames)[number], boolean> = {
      APNS_ENVIRONMENT: environment !== "",
      APNS_TEAM_ID: teamId !== "",
      APNS_KEY_ID: keyId !== "",
      APNS_BUNDLE_ID: bundleId !== "",
      APNS_PRIVATE_KEY: Redacted.value(privateKey) !== "",
    };
    const missing = apnsConfigNames.filter((name) => !present[name]);
    if (missing.length === apnsConfigNames.length) {
      return null;
    }
    if (missing.length > 0) {
      return yield* Effect.fail(
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message: `Partial APNs configuration: set all of ${apnsConfigNames.join(", ")} or none of them. Missing: ${missing.join(", ")}`,
          }),
        ),
      );
    }
    return {
      environment: yield* Config.schema(ApnsEnvironment, "APNS_ENVIRONMENT"),
      teamId,
      keyId,
      bundleId,
      privateKey,
    };
  });

export type EmailSignInDelivery =
  | { readonly kind: "disabled" }
  | { readonly kind: "log" }
  | { readonly kind: "cloudflare"; readonly fromAddress: string; readonly fromName: string };

export interface EmailSignInSettings {
  readonly delivery: EmailSignInDelivery;
  readonly testSignInCode: string | undefined;
}

const decodeEmailSignInDeliveryKind = Schema.decodeUnknownEffect(
  Schema.Literals(["cloudflare", "log"]),
);

/**
 * Email sign-in stays off until `RELAY_EMAIL_FROM_ADDRESS` is set, or on a
 * non-production stage `RELAY_EMAIL_DELIVERY=log`. Log delivery and the fixed
 * test code are refused on prod, where they would let anyone read or skip codes.
 */
export const emailSignInConfig = (stage: string) =>
  Effect.gen(function* () {
    const fromAddress = (yield* Config.String("RELAY_EMAIL_FROM_ADDRESS").pipe(
      Config.withDefault(""),
    )).trim();
    const fromName =
      (yield* Config.String("RELAY_EMAIL_FROM_NAME").pipe(Config.withDefault(""))).trim() ||
      "styal";
    const deliveryValue =
      (yield* Config.String("RELAY_EMAIL_DELIVERY").pipe(Config.withDefault(""))).trim() ||
      "cloudflare";
    const deliveryKind = yield* decodeEmailSignInDeliveryKind(deliveryValue).pipe(
      Effect.mapError((error) => new Config.ConfigError(error)),
    );
    const testSignInCode =
      (yield* Config.String("RELAY_TEST_SIGN_IN_CODE").pipe(Config.withDefault(""))).trim() ||
      undefined;

    const refuse = (message: string) =>
      Effect.fail(new Config.ConfigError(new ConfigProvider.SourceError({ message })));
    if (stage === "prod" && deliveryKind === "log") {
      return yield* refuse("RELAY_EMAIL_DELIVERY=log is not allowed on the prod stage.");
    }
    if (stage === "prod" && testSignInCode !== undefined) {
      return yield* refuse("RELAY_TEST_SIGN_IN_CODE is not allowed on the prod stage.");
    }
    if (testSignInCode !== undefined && !/^\d{8}$/.test(testSignInCode)) {
      return yield* refuse("RELAY_TEST_SIGN_IN_CODE must be eight digits.");
    }

    const delivery: EmailSignInDelivery =
      deliveryKind === "log"
        ? { kind: "log" }
        : fromAddress === ""
          ? { kind: "disabled" }
          : { kind: "cloudflare", fromAddress, fromName };
    return { delivery, testSignInCode } satisfies EmailSignInSettings;
  });
