import { ClerkFailed, useClerk } from "@clerk/react";
import {
  createCloudAccountService,
  managedRelayAuthLoadAtom,
  ManagedRelay,
  setManagedRelaySession,
} from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  runAtomCommand,
  settleAsyncResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { useEffect, type ReactNode } from "react";

import { environmentCatalog } from "../connection/catalog";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

export function deactivateManagedRelayAuthentication(): void {
  setManagedRelaySession(appAtomRegistry, null);
  markManagedRelayAuthLoaded();
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
  markManagedRelayAuthLoaded();
}

type ClerkInstance = ReturnType<typeof useClerk>;

function clerkTokenReader(clerk: ClerkInstance): () => Promise<string | null> {
  return async () =>
    clerk.session ? await clerk.session.getToken(resolveRelayClerkTokenOptions()) : null;
}

const managedRelayAccountService = createCloudAccountService<ClerkInstance>({
  deactivate: deactivateManagedRelayAuthentication,
  detach: deactivateManagedRelayAuthentication,
  cleanUp: async () => {
    const results = await Promise.all([
      runAtomCommand(appAtomRegistry, environmentCatalog.removeRelayEnvironments, undefined, {
        reportFailure: false,
        reportDefect: false,
      }),
      settleAsyncResult(() =>
        runtime.runPromiseExit(
          ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => client.resetTokenCache)),
        ),
      ),
    ]);
    for (const result of results) {
      reportAtomCommandResult(result, { label: "cloud account cleanup" });
    }
  },
  activate: ({ source, accountId }) =>
    activateManagedRelayAuthentication(accountId, clerkTokenReader(source)),
});

export function ManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  // ClerkProvider creates the Clerk instance and owns its lifetime, so the
  // account service observes it for as long as this provider is mounted.
  const clerk = useClerk();
  useEffect(() => managedRelayAccountService.attach(clerk), [clerk]);
  return (
    <>
      <ClerkFailed>
        <ManagedRelayAuthLoadFailed />
      </ClerkFailed>
      {children}
    </>
  );
}
