import type { ReactNode } from "react";
import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";
export default function ManagedAuthShell({ children }: { readonly children: ReactNode }) {
  return <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>;
}
