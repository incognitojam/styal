import * as LegacyRelay from "@t3tools/client-runtime/relay";
import { DpopProof, ManagedRelay } from "@t3tools/client-runtime/relay-session";
import { RelayMobileClientId } from "@t3tools/contracts/relay";
import * as Layer from "effect/Layer";

import { loadOrCreateProofKey } from "./dpop";
import { managedRelayAccessTokenStore } from "./managedRelayTokenStore";
import { endRelaySession } from "./relaySessionStore";

const layerRelayDpopSigner = DpopProof.layerSigner({
  keyStore: "expo-secure-store",
  loadOrCreateKey: loadOrCreateProofKey(),
});

export const layer = (relayUrl: string) =>
  Layer.merge(
    LegacyRelay.ManagedRelay.layer({ relayUrl, clientId: RelayMobileClientId }),
    ManagedRelay.layer({
      relayUrl,
      clientId: RelayMobileClientId,
      accessTokenStore: managedRelayAccessTokenStore,
      onSessionEnded: endRelaySession,
    }),
  ).pipe(Layer.provideMerge(layerRelayDpopSigner));
