import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const ApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type ApnsEnvironment = typeof ApnsEnvironment.Type;

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
    readonly clerkSecretKey: Redacted.Redacted<string>;
    readonly clerkPublishableKey: string;
    readonly clerkJwtAudience: string;
    readonly apnsDeliveryJobSigningSecret: Redacted.Redacted<string>;
    readonly cloudMintPrivateKey: Redacted.Redacted<string>;
    readonly cloudMintPublicKey: string;
    readonly managedEndpointBaseDomain: string | undefined;
    readonly managedEndpointNamespace: string | undefined;
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
  Config.string(name).pipe(Config.withDefault(""));

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
    const privateKey = yield* Config.redacted("APNS_PRIVATE_KEY").pipe(
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
