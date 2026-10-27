import { ClerkProvider, getClerkInstance, useClerk } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { type ReactNode, useEffect } from "react";
import { AppState } from "react-native";
import { managedRelayAuthLoadAtom } from "@t3tools/client-runtime/relay";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  limitClerkRequestDuration,
  recoverableClerkTokenCache,
  retryFailedClerkLoads,
} from "./clerkLoadRecovery";

import { cloudAccountService, deactivateCloudRelayAccount } from "./cloudAccountService";
import { resolveCloudPublicConfig } from "./publicConfig";

const cloudTokenCache = tokenCache ? recoverableClerkTokenCache(tokenCache) : undefined;

const cloudConfig = resolveCloudPublicConfig();
// Build-time constant: null when this build has no cloud config.
const publishableKey = cloudConfig.relay.url ? cloudConfig.clerk.publishableKey : null;

if (publishableKey) {
  // The same native singleton ClerkProvider renders with, so the service
  // observes it for the app's lifetime without a React subscription.
  const clerk = getClerkInstance({ publishableKey });
  limitClerkRequestDuration(clerk);
  cloudAccountService.attach(clerk);
} else {
  // Without cloud config no account can ever activate, so drop anything a
  // previous build with cloud enabled left registered.
  deactivateCloudRelayAccount();
}

function ClerkLoadRecovery() {
  const clerk = useClerk();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to native app activation to retry failed Clerk runtime loads
  useEffect(
    () =>
      retryFailedClerkLoads(
        clerk,
        (listener) => {
          const subscription = AppState.addEventListener("change", (state) => {
            if (state === "active") listener();
          });
          return () => subscription.remove();
        },
        // Stays "failed" through retries until a load activates or clears the session.
        () => appAtomRegistry.set(managedRelayAuthLoadAtom, "failed"),
      ),
    [clerk],
  );
  return null;
}

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  if (!publishableKey) {
    return props.children;
  }

  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={cloudTokenCache}>
      <ClerkLoadRecovery />
      {props.children}
    </ClerkProvider>
  );
}
