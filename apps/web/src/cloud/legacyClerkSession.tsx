import { useAuth, useClerk } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import { managedRelayAuthLoadAtom, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { useEffect, useRef } from "react";

import { runtime } from "../lib/runtime";
import { isLegacyCliConnectRoute } from "./connectCliAuth";
import { resolveRelayClerkTokenOptions } from "./publicConfig";
import { adoptClerkSession, setLegacyClerkSignOut } from "./relaySession";
import { legacyClerkAdoptionAllowed } from "./relaySessionStore";

/**
 * Moves a browser that is still signed in with Clerk to a relay session for
 * the same account, once, then signs Clerk out so a later styal Link sign-out
 * stays signed out. Mounted only while Clerk is still configured.
 */
export function LegacyClerkSessionAdoption() {
  const clerk = useClerk();
  const { getToken, isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const session = useAtomValue(managedRelaySessionAtom);
  const loadState = useAtomValue(managedRelayAuthLoadAtom);
  const attemptedRef = useRef(false);

  useEffect(() => {
    if (isLegacyCliConnectRoute()) return;
    setLegacyClerkSignOut(() => (isLegacyCliConnectRoute() ? Promise.resolve() : clerk.signOut()));
    return () => setLegacyClerkSignOut(null);
  }, [clerk]);

  useEffect(() => {
    if (isLegacyCliConnectRoute()) return;
    if (window.isSecureContext === false || !globalThis.crypto?.subtle) return;
    // Once this page has had a relay session, a later "no session" means the
    // user signed out; moving the Clerk sign-in over then would undo that.
    if (session !== null) {
      attemptedRef.current = true;
      return;
    }
    if (!isLoaded || !isSignedIn || loadState !== "loaded") return;
    if (attemptedRef.current) return;
    attemptedRef.current = true;
    void (async () => {
      const allowed = await runtime.runPromise(legacyClerkAdoptionAllowed).catch(() => undefined);
      if (allowed === undefined) {
        // Keep Clerk available for a later retry if local storage cannot be read.
        attemptedRef.current = false;
        return;
      }
      if (!allowed) {
        // A relay session existed here before; finish the Clerk sign-out instead.
        if (!isLegacyCliConnectRoute()) await clerk.signOut().catch(() => undefined);
        return;
      }
      const clerkToken = await getToken(resolveRelayClerkTokenOptions()).catch(() => null);
      if (!clerkToken || isLegacyCliConnectRoute()) return;
      const exit = await runtime.runPromiseExit(adoptClerkSession(clerkToken));
      if (exit._tag === "Failure") {
        // The user can still sign in with an email code; the next launch tries again.
        console.warn("[styal-link] Could not move the Clerk sign-in to the relay", exit.cause);
      }
    })();
  }, [clerk, getToken, isLoaded, isSignedIn, loadState, session]);

  return null;
}
