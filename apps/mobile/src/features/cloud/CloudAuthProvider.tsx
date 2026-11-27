import { type ReactNode, useEffect } from "react";
import { AppState } from "react-native";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  cloudAccountService,
  deactivateCloudRelayAccount,
  relaySignInSource,
} from "./cloudAccountService";
import { resolveCloudPublicConfig } from "./publicConfig";
import { restoreRelaySession } from "./relaySession";
import { publishRelaySignIn, relaySignInAtom } from "./relaySessionStore";

const relayUrl = resolveCloudPublicConfig().relay.url;
if (relayUrl) {
  cloudAccountService.attach(relaySignInSource);
} else {
  deactivateCloudRelayAccount();
  publishRelaySignIn(null);
}

function RelaySessionRestore() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the saved sign-in on mount and retries on native app activation
  useEffect(() => {
    void restoreRelaySession();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      cloudAccountService.retry();
      if (appAtomRegistry.get(relaySignInAtom).status === "failed") {
        void restoreRelaySession();
      }
    });
    return () => subscription.remove();
  }, []);
  return null;
}

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  return (
    <>
      {relayUrl ? <RelaySessionRestore /> : null}
      {props.children}
    </>
  );
}
