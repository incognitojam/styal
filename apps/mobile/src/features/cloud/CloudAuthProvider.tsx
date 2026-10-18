import { ClerkProvider, getClerkInstance, useAuth, useClerk } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { useAtomValue } from "@effect/atom-react";
import { type ReactNode, useEffect, useRef } from "react";
import { AppState } from "react-native";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  limitClerkRequestDuration,
  recoverableClerkTokenCache,
  retryFailedClerkLoads,
} from "./clerkLoadRecovery";
import {
  cloudAccountService,
  deactivateCloudRelayAccount,
  relaySignInSource,
} from "./cloudAccountService";
import {
  hasLegacyClerkConfig,
  resolveCloudPublicConfig,
  resolveRelayClerkTokenOptions,
} from "./publicConfig";
import {
  adoptClerkSession,
  failClerkAdoption,
  finishClerkAdoptionSignedOut,
  restoreRelaySession,
  setLegacyClerkSignOut,
} from "./relaySession";
import { publishRelaySignIn, relaySignInAtom } from "./relaySessionStore";

const cloudTokenCache = tokenCache ? recoverableClerkTokenCache(tokenCache) : undefined;

const cloudConfig = resolveCloudPublicConfig();
// Build-time constants: no relay URL means this build has no styal Link.
const relayUrl = cloudConfig.relay.url;
// Clerk stays only to move an existing Clerk sign-in to a relay session.
const legacyClerkPublishableKey = hasLegacyClerkConfig(cloudConfig)
  ? cloudConfig.clerk.publishableKey
  : null;

if (relayUrl) {
  // Observes the relay sign-in for the app's lifetime without a React subscription.
  cloudAccountService.attach(relaySignInSource);
  if (legacyClerkPublishableKey) {
    limitClerkRequestDuration(getClerkInstance({ publishableKey: legacyClerkPublishableKey }));
  }
} else {
  // Without styal Link no account can ever activate, so drop anything a
  // previous build with it enabled left registered.
  deactivateCloudRelayAccount();
  publishRelaySignIn(null);
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
        // Only matters while an older Clerk sign-in may still need moving.
        failClerkAdoption,
      ),
    [clerk],
  );
  return null;
}

/**
 * Moves a device that is still signed in with Clerk to a relay session for
 * the same account, once, then signs Clerk out so a later styal Link sign-out
 * stays signed out. Mounted only while the build still has Clerk settings.
 */
function LegacyClerkSessionAdoption() {
  const clerk = useClerk();
  const { getToken, isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const signIn = useAtomValue(relaySignInAtom);
  const attemptingRef = useRef(false);
  const leftoverSignOutRef = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the Clerk sign-out in the session module while Clerk is mounted
  useEffect(() => {
    setLegacyClerkSignOut(() => clerk.signOut());
    return () => setLegacyClerkSignOut(null);
  }, [clerk]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves a Clerk session, which only this provider can read, into the relay session store
  useEffect(() => {
    if (!isLoaded) return;
    if (signIn.status === "ready") {
      // An earlier move whose Clerk sign-out did not finish.
      if (isSignedIn && signIn.session !== null && !leftoverSignOutRef.current) {
        leftoverSignOutRef.current = true;
        void clerk.signOut().catch(() => undefined);
      }
      return;
    }
    if (signIn.status !== "adopting") return;
    if (!isSignedIn) {
      void finishClerkAdoptionSignedOut();
      return;
    }
    if (attemptingRef.current) return;
    attemptingRef.current = true;
    void adoptClerkSession(() => getToken(resolveRelayClerkTokenOptions())).finally(() => {
      attemptingRef.current = false;
    });
  }, [clerk, getToken, isLoaded, isSignedIn, signIn]);

  return null;
}

function RelaySessionRestore() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the saved sign-in on mount and retries on native app activation
  useEffect(() => {
    void restoreRelaySession();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && appAtomRegistry.get(relaySignInAtom).status === "failed") {
        void restoreRelaySession();
      }
    });
    return () => subscription.remove();
  }, []);
  return null;
}

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  if (!relayUrl) {
    return props.children;
  }

  return (
    <>
      <RelaySessionRestore />
      {legacyClerkPublishableKey ? (
        <ClerkProvider publishableKey={legacyClerkPublishableKey} tokenCache={cloudTokenCache}>
          <ClerkLoadRecovery />
          <LegacyClerkSessionAdoption />
        </ClerkProvider>
      ) : null}
      {props.children}
    </>
  );
}
