import { lazy, Suspense, type ReactNode } from "react";
import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";
const LegacyCliShell = lazy(() => import("./LegacyCliManagedAuthShell"));
export default function ManagedAuthShell({ children }: { readonly children: ReactNode }) {
  const key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  const content =
    window.location.pathname === "/connect" && key ? (
      <Suspense fallback={null}>
        <LegacyCliShell publishableKey={key}>{children}</LegacyCliShell>
      </Suspense>
    ) : (
      children
    );
  return <ManagedRelayAuthProvider>{content}</ManagedRelayAuthProvider>;
}
