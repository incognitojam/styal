import * as LegacyRelay from "@t3tools/client-runtime/relay";
import { DpopProof, ManagedRelay } from "@t3tools/client-runtime/relay-session";
import { RelayWebClientId } from "@t3tools/contracts/relay";
import * as Layer from "effect/Layer";

import { endRelaySession } from "./relaySessionStore";
import { loadOrCreateProofKey } from "./dpop";

const layerRelayDpopSigner = DpopProof.layerSigner({
  keyStore: "indexed-db",
  loadOrCreateKey: loadOrCreateProofKey(),
});

export const layer = (relayUrl: string) =>
  Layer.merge(
    ManagedRelay.layer({ relayUrl, clientId: RelayWebClientId, onSessionEnded: endRelaySession }),
    LegacyRelay.ManagedRelay.layer({ relayUrl, clientId: RelayWebClientId }),
  ).pipe(Layer.provideMerge(layerRelayDpopSigner));
