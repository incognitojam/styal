import { useAtomValue } from "@effect/atom-react";
import {
  managedRelayAuthLoadAtom,
  managedRelaySessionAtom,
} from "@t3tools/client-runtime/relay-session";

/** The signed-in styal Link account, read from the relay session atom. */
export function useRelayAccount() {
  const session = useAtomValue(managedRelaySessionAtom);
  const loadState = useAtomValue(managedRelayAuthLoadAtom);
  return {
    isLoaded: loadState !== "loading",
    isSignedIn: session !== null,
    accountId: session?.accountId ?? null,
    userId: session?.accountId ?? null,
    email: session?.email ?? null,
    session,
  };
}

import { restoreRelaySession } from "./relaySession";
export const retryRelayLoad = () => void restoreRelaySession();
export function useRelayLoadFailed() {
  return useAtomValue(managedRelayAuthLoadAtom) === "failed";
}
