import { ClerkProvider } from "@clerk/react";
import type { ReactNode } from "react";

import { LegacyClerkSessionAdoption } from "../../cloud/legacyClerkSession";
import { isLegacyCliConnectRoute } from "../../cloud/connectCliAuth";
import { clerkAppearance } from "./clerkAppearance";

/** Lazy-load Clerk so cloudless local mode never downloads it. */
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
