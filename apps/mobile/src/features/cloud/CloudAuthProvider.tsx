import { ClerkProvider, getClerkInstance, useAuth, useClerk } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { useAtomValue } from "@effect/atom-react";
import {
  ManagedRelay,
  managedRelayAuthLoadAtom,
  type ManagedRelaySession,
  setManagedRelaySession,
} from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { type ReactNode, useEffect, useRef } from "react";
import { AppState } from "react-native";

import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  getComposerCloudAccountId,
  restoreCloudComposerDrafts,
} from "../../state/use-composer-drafts";
import {
  releaseAgentAwarenessRelayCredential,
  setAgentAwarenessRelayCredential,
} from "../agent-awareness/remoteRegistration";
import {
  limitClerkRequestDuration,
  recoverableClerkTokenCache,
  retryFailedClerkLoads,
} from "./clerkLoadRecovery";
import { clearConnectOnboardingRequest, requestConnectOnboarding } from "./connectOnboarding";
import {
  hasLegacyClerkConfig,
  resolveCloudPublicConfig,
  resolveRelayClerkTokenOptions,
} from "./publicConfig";
import { removeCloudEnvironments } from "./cloud-drafts";
import {
  adoptClerkSession,
  failClerkAdoption,
  finishClerkAdoptionSignedOut,
  restoreRelaySession,
  setLegacyClerkSignOut,
} from "./relaySession";
import { publishRelaySignIn, relaySignInAtom } from "./relaySessionStore";

// Keep the wrapper stable: Clerk uses the cache identity to track native sync.
const cloudTokenCache = tokenCache ? recoverableClerkTokenCache(tokenCache) : undefined;

function resetManagedRelayTokenCache() {
  return settleAsyncResult(() =>
    runtime.runPromiseExit(
      ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => client.resetTokenCache)),
    ),
  );
}

/**
 * Credential cleanup must finish even when preserving local drafts fails. The
 * device's relay registration is removed by sign-out itself, before the
 * session ends.
 */
export async function cleanUpCloudRelayAccount(
  removeEnvironments: () => Promise<void>,
): Promise<void> {
  try {
    await removeEnvironments();
  } finally {
    reportAtomCommandResult(await resetManagedRelayTokenCache(), {
      label: "cloud account cleanup",
    });
  }
}

export function deactivateCloudRelayAccount(): void {
  setAgentAwarenessRelayCredential(null);
  setManagedRelaySession(appAtomRegistry, null);
  appAtomRegistry.set(managedRelayAuthLoadAtom, "loaded");
}

export function activateCloudRelayAccount(session: ManagedRelaySession): void {
  setAgentAwarenessRelayCredential(session.credential);
  setManagedRelaySession(appAtomRegistry, session);
  appAtomRegistry.set(managedRelayAuthLoadAtom, "loaded");
}

function ClerkLoadRecovery() {
  const clerk = useClerk();
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

  useEffect(() => {
    setLegacyClerkSignOut(() => clerk.signOut());
    return () => setLegacyClerkSignOut(null);
  }, [clerk]);

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

function CloudAuthBridge(props: { readonly children: ReactNode }) {
  const signIn = useAtomValue(relaySignInAtom);
  const isLoaded = signIn.status === "ready";
  const session = signIn.status === "ready" ? signIn.session : null;
  const removeRelayEnvironments = useAtomCommand(removeCloudEnvironments, {
    reportFailure: false,
    reportDefect: false,
  });
  const observedAccountRef = useRef<string | null | undefined>(undefined);
  const accountTransitionRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Loading, moving a Clerk sign-in, or a failed load is not a sign-out:
    // leave the current state alone until the sign-in is known.
    if (!isLoaded) {
      return;
    }

    const previousObservedAccount = observedAccountRef.current;
    const nextAccount = session?.accountId ?? null;
    observedAccountRef.current = nextAccount;

    // Every sign-in or account switch that completes during this session (a
    // cold start observes undefined → account and must not re-prompt) requests
    // the styal Link onboarding sheet — account transitions clear the
    // connected environments, so each new session starts with no devices to
    // reach. The request itself is issued after the cleanup transition inside
    // activateSession, so the sheet never lists the previous account's
    // environments; sign-out drops any not-yet-presented request instead.
    const isAccountTransition =
      previousObservedAccount !== undefined && previousObservedAccount !== nextAccount;
    if (isAccountTransition && nextAccount === null) {
      clearConnectOnboardingRequest();
    }

    const cleanUpAccount = async (accountId: string | null) => {
      await cleanUpCloudRelayAccount(async () => {
        const removal = await removeRelayEnvironments(accountId);
        if (removal._tag !== "Success") throw squashAtomCommandFailure(removal);
      });
    };
    const queueAccountCleanup = () => {
      const previousTransition = accountTransitionRef.current ?? Promise.resolve();
      accountTransitionRef.current = previousTransition
        .catch(() => {})
        .then(() => cleanUpAccount(previousObservedAccount ?? null));
      return accountTransitionRef.current;
    };

    if (session === null) {
      deactivateCloudRelayAccount();
      if (previousObservedAccount !== null) {
        void settlePromise(() => queueAccountCleanup()).then((result) => {
          reportAtomCommandResult(result, { label: "cloud account cleanup" });
        });
      }
      return;
    }

    const userId = session.accountId;
    const activateSession = () => {
      if (cancelled) {
        return;
      }
      activateCloudRelayAccount(session);
      if (isAccountTransition) {
        requestConnectOnboarding(userId);
      }
    };
    const activateAfterTransition = (transition: Promise<void>) => {
      const activation = (async () => {
        await transition;
        if (cancelled) return;
        const storedAccount = await getComposerCloudAccountId();
        if (storedAccount !== null && storedAccount !== userId) {
          await cleanUpAccount(storedAccount);
        }
        if (cancelled) return;
        await restoreCloudComposerDrafts(userId);
        activateSession();
      })();
      accountTransitionRef.current = activation;
      void settlePromise(() => activation).then((result) => {
        // A failed activation leaves no relay session, so connections must stop
        // reporting that the sign-in is still loading.
        if (result._tag !== "Success" && !cancelled) {
          appAtomRegistry.set(managedRelayAuthLoadAtom, "loaded");
        }
        reportAtomCommandResult(result, { label: "cloud account activation" });
      });
    };
    if (
      previousObservedAccount !== undefined &&
      previousObservedAccount !== null &&
      previousObservedAccount !== userId
    ) {
      deactivateCloudRelayAccount();
      activateAfterTransition(queueAccountCleanup());
    } else {
      // A failed disk write can be retried. The persisted account check above
      // still requires cleanup before activating a different account.
      activateAfterTransition((accountTransitionRef.current ?? Promise.resolve()).catch(() => {}));
    }

    return () => {
      cancelled = true;
    };
  }, [isLoaded, removeRelayEnvironments, session]);

  useEffect(
    () => () => {
      // Unmounting is not a sign-out: the user is usually still signed in, so
      // detach the credential without ending lock-screen activities or wiping
      // the persisted registration (a remount reuses both).
      releaseAgentAwarenessRelayCredential();
      setManagedRelaySession(appAtomRegistry, null);
    },
    [],
  );

  return props.children;
}

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  const config = resolveCloudPublicConfig();
  const relayUrl = config.relay.url;
  const publishableKey = hasLegacyClerkConfig(config) ? config.clerk.publishableKey : null;

  useEffect(() => {
    if (!relayUrl) {
      deactivateCloudRelayAccount();
      publishRelaySignIn(null);
      return;
    }
    void restoreRelaySession();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && appAtomRegistry.get(relaySignInAtom).status === "failed") {
        void restoreRelaySession();
      }
    });
    return () => subscription.remove();
  }, [relayUrl]);

  if (!relayUrl) {
    return props.children;
  }

  if (publishableKey) {
    limitClerkRequestDuration(getClerkInstance({ publishableKey }));
  }

  return (
    <>
      {publishableKey ? (
        <ClerkProvider publishableKey={publishableKey} tokenCache={cloudTokenCache}>
          <ClerkLoadRecovery />
          <LegacyClerkSessionAdoption />
        </ClerkProvider>
      ) : null}
      <CloudAuthBridge>{props.children}</CloudAuthBridge>
    </>
  );
}
