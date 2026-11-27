import { ClerkProvider } from "@clerk/react";
import type { ReactNode } from "react";
import { clerkAppearance } from "./clerkAppearance";
export default function LegacyCliManagedAuthShell({
  children,
  publishableKey,
}: {
  readonly children: ReactNode;
  readonly publishableKey: string;
}) {
  return (
    <ClerkProvider appearance={clerkAppearance} publishableKey={publishableKey}>
      {children}
    </ClerkProvider>
  );
}
