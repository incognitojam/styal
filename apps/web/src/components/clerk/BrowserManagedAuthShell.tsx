import { ClerkProvider } from "@clerk/react";
import type { ReactNode } from "react";

import { LegacyClerkSessionAdoption } from "../../cloud/legacyClerkSession";
import { isLegacyCliConnectRoute } from "../../cloud/connectCliAuth";
import { clerkAppearance } from "./clerkAppearance";

/**
 * Browser half of the managed-auth boundary, loaded lazily from the entry so
 * cloudless local mode never downloads a Clerk runtime. The browser provider
 * stays small on its own: it hotloads clerk-js at runtime instead of bundling
 * it.
 */
export default function BrowserManagedAuthShell({
  publishableKey,
  children,
}: {
  readonly publishableKey: string;
  readonly children: ReactNode;
}) {
  return (
    <ClerkProvider appearance={clerkAppearance} publishableKey={publishableKey}>
      {isLegacyCliConnectRoute() ? null : <LegacyClerkSessionAdoption />}
      {children}
    </ClerkProvider>
  );
}
