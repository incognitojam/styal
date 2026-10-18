import * as Redacted from "effect/Redacted";
import * as RelayConfiguration from "../Config.ts";

export const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: RelayConfiguration.disabledApnsCredentials,
  apnsDeliveryJobSigningSecret: Redacted.make("synthetic-job-secret"),
  clerkSecretKey: Redacted.make(""),
  clerkPublishableKey: "",
  clerkJwtAudience: "relay-test",
  signInCodeSecret: Redacted.make("synthetic-code-secret"),
  cloudMintPrivateKey: Redacted.make("unused-in-this-test"),
  cloudMintPublicKey: "unused-in-this-test",
  managedEndpointBaseDomain: "endpoint.example.test",
  managedEndpointNamespace: "test",
});
