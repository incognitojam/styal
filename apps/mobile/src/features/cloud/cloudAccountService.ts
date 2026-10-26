import type { getClerkInstance } from "@clerk/expo";
import {
  createCloudAccountService,
  ManagedRelay,
  managedRelayAuthLoadAtom,
  setManagedRelaySession,
} from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  runAtomCommand,
  settleAsyncResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  getComposerCloudAccountId,
  restoreCloudComposerDrafts,
} from "../../state/use-composer-drafts";
import {
  releaseAgentAwarenessRelayTokenProvider,
  setAgentAwarenessRelayTokenProvider,
  unregisterAgentAwarenessDeviceForCurrentUser,
} from "../agent-awareness/remoteRegistration";
import { removeCloudEnvironments } from "./cloud-drafts";
import { clearConnectOnboardingRequest, requestConnectOnboarding } from "./connectOnboarding";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

type ClerkInstance = ReturnType<typeof getClerkInstance>;

export function deactivateCloudRelayAccount(): void {
  appAtomRegistry.set(managedRelayAuthLoadAtom, "loaded");
  setAgentAwarenessRelayTokenProvider(null);
  setManagedRelaySession(appAtomRegistry, null);
}

export function activateCloudRelayAccount(
  accountId: string,
  tokenProvider: () => Promise<string | null>,
): void {
  appAtomRegistry.set(managedRelayAuthLoadAtom, "loaded");
  setAgentAwarenessRelayTokenProvider(tokenProvider, accountId);
  setManagedRelaySession(appAtomRegistry, {
    accountId,
    readClerkToken: tokenProvider,
  });
}

function resetManagedRelayTokenCache() {
  return settleAsyncResult(() =>
    runtime.runPromiseExit(
      ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => client.resetTokenCache)),
    ),
  );
}

/** Credential cleanup must finish even when preserving local drafts fails. */
export async function cleanUpCloudRelayAccount(
  removeEnvironments: () => Promise<void>,
  previousTokenProvider: (() => Promise<string | null>) | null,
): Promise<void> {
  try {
    await removeEnvironments();
  } finally {
    const results = await Promise.all([
      resetManagedRelayTokenCache(),
      ...(previousTokenProvider
        ? [
            settleAsyncResult(() =>
              runtime.runPromiseExit(
                unregisterAgentAwarenessDeviceForCurrentUser(previousTokenProvider),
              ),
            ),
          ]
        : []),
    ]);
    for (const result of results) {
      reportAtomCommandResult(result, { label: "cloud account cleanup" });
    }
  }
}

const cleanUpCloudAccount = async (
  _clerk: ClerkInstance,
  accountId: string | null,
  wasActive: boolean,
) => {
  await cleanUpCloudRelayAccount(
    async () => {
      const removal = await runAtomCommand(appAtomRegistry, removeCloudEnvironments, accountId, {
        reportFailure: false,
        reportDefect: false,
      });
      if (removal._tag !== "Success") throw squashAtomCommandFailure(removal);
    },
    wasActive ? previousTokenProvider : null,
  );
};

let previousTokenProvider: (() => Promise<string | null>) | null = null;

export const cloudAccountService = createCloudAccountService<ClerkInstance>({
  deactivate: deactivateCloudRelayAccount,
  // Detaching is not a sign-out: the user is usually still signed in, so keep
  // lock-screen activities and the persisted registration for the next attach.
  detach: () => {
    releaseAgentAwarenessRelayTokenProvider();
    setManagedRelaySession(appAtomRegistry, null);
  },
  // A not-yet-presented onboarding request belongs to the account that left.
  onSignOutTransition: clearConnectOnboardingRequest,
  cleanUp: ({ source, accountId, wasActive }) => cleanUpCloudAccount(source, accountId, wasActive),
  prepare: async ({ source, accountId, isCurrent }) => {
    try {
      const storedAccount = await getComposerCloudAccountId();
      if (storedAccount !== null && storedAccount !== accountId) {
        await cleanUpCloudAccount(source, storedAccount, false);
      }
      if (!isCurrent()) return;
      await restoreCloudComposerDrafts(accountId);
    } catch (error) {
      if (isCurrent()) appAtomRegistry.set(managedRelayAuthLoadAtom, "loaded");
      throw error;
    }
  },
  activate: ({ source, accountId, isAccountTransition }) => {
    const session = source.session;
    previousTokenProvider = () =>
      session ? session.getToken(resolveRelayClerkTokenOptions()) : Promise.resolve(null);
    activateCloudRelayAccount(accountId, previousTokenProvider);
    // Issued after cleanup so the sheet never lists the previous account's environments.
    if (isAccountTransition) requestConnectOnboarding(accountId);
  },
});
