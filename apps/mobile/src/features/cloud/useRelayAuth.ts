import { useAtomValue } from "@effect/atom-react";

import { relaySignInAtom } from "./relaySessionStore";

/**
 * The styal Link sign-in for screens. `isLoaded` is false only while the saved
 * sign-in or an older Clerk sign-in is still being read, so a failed load
 * still lets the user sign in again.
 */
export function useRelayAuth() {
  const state = useAtomValue(relaySignInAtom);
  const session = state.status === "ready" ? state.session : null;
  return {
    status: state.status,
    isLoaded: state.status === "ready" || state.status === "failed",
    isSignedIn: session !== null,
    session,
    accountId: session?.accountId ?? null,
    email: session?.email ?? null,
  };
}
