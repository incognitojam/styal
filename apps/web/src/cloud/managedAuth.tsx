import { useEffect, type ReactNode } from "react";

import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { restoreRelaySession } from "./relaySession";

export function ManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores the saved sign-in from browser storage on mount
  useEffect(() => {
    void restoreRelaySession();
  }, []);
  return <AppAtomRegistryProvider>{children}</AppAtomRegistryProvider>;
}
