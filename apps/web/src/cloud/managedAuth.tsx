import { ClerkFailed, useAuth } from "@clerk/react";
import {
  ManagedRelay,
  managedRelayAuthLoadAtom,
  setManagedRelaySession,
} from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { useEffect, useRef, type ReactNode } from "react";

import { environmentCatalog } from "../connection/catalog";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

export function deactivateManagedRelayAuthentication(): void {
  setManagedRelaySession(appAtomRegistry, null);
}

function markManagedRelayAuthLoaded(): void {
  appAtomRegistry.set(managedRelayAuthLoadAtom, "loaded");
}

/** Mounted by Clerk only after its runtime failed to load, which it does not retry. */
function ManagedRelayAuthLoadFailed() {
  useEffect(() => {
    appAtomRegistry.set(managedRelayAuthLoadAtom, "failed");
  }, []);
  return null;
}

export function activateManagedRelayAuthentication(
  accountId: string,
  readClerkToken: () => Promise<string | null>,
): void {
  setManagedRelaySession(appAtomRegistry, {
    accountId,
    readClerkToken,
  });
}

export function ManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const removeRelayEnvironments = useAtomCommand(environmentCatalog.removeRelayEnvironments, {
    reportFailure: false,
    reportDefect: false,
  });
  const observedAccountRef = useRef<string | null | undefined>(undefined);
  const accountTransitionRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }

    let cancelled = false;
    const previousAccount = observedAccountRef.current;
    const nextAccount = isSignedIn && userId ? userId : null;
    observedAccountRef.current = nextAccount;

    const queueAccountCleanup = () => {
      const previousTransition = accountTransitionRef.current ?? Promise.resolve();
      accountTransitionRef.current = previousTransition.then(async () => {
        const results = await Promise.all([
          removeRelayEnvironments(),
          settleAsyncResult(() =>
            runtime.runPromiseExit(
              ManagedRelay.ManagedRelayClient.pipe(
                Effect.flatMap((client) => client.resetTokenCache),
              ),
            ),
          ),
        ]);
        for (const result of results) {
          reportAtomCommandResult(result, { label: "cloud account cleanup" });
        }
      });
      return accountTransitionRef.current;
    };

    if (!isSignedIn || !userId) {
      deactivateManagedRelayAuthentication();
      markManagedRelayAuthLoaded();
      if (previousAccount !== null) {
        void queueAccountCleanup();
      }
    } else {
      const tokenProvider = () => getToken(resolveRelayClerkTokenOptions());
      const activateSession = () => {
        if (!cancelled) {
          activateManagedRelayAuthentication(userId, tokenProvider);
          markManagedRelayAuthLoaded();
        }
      };
      const activateAfterTransition = (transition: Promise<void>) => {
        void (async () => {
          const result = await settlePromise(async () => {
            await transition;
            activateSession();
          });
          // A failed activation leaves no session; stop reporting that the sign-in is loading.
          if (result._tag !== "Success" && !cancelled) markManagedRelayAuthLoaded();
          reportAtomCommandResult(result, { label: "cloud account activation" });
        })();
      };
      if (previousAccount !== undefined && previousAccount !== null && previousAccount !== userId) {
        deactivateManagedRelayAuthentication();
        activateAfterTransition(queueAccountCleanup());
      } else {
        activateAfterTransition(accountTransitionRef.current ?? Promise.resolve());
      }
    }
    return () => {
      cancelled = true;
    };
  }, [getToken, isLoaded, isSignedIn, removeRelayEnvironments, userId]);

  useEffect(() => () => deactivateManagedRelayAuthentication(), []);

  return (
    <>
      <ClerkFailed>
        <ManagedRelayAuthLoadFailed />
      </ClerkFailed>
      {children}
    </>
  );
}
