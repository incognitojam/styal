import {
  type CloudAccountSource,
  createCloudAccountService,
  ManagedRelay,
  managedRelayAuthLoadAtom,
  type ManagedRelaySession,
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
  releaseAgentAwarenessRelayCredential,
  setAgentAwarenessRelayCredential,
} from "../agent-awareness/remoteRegistration";
import { removeCloudEnvironments } from "./cloud-drafts";
import { clearConnectOnboardingRequest, requestConnectOnboarding } from "./connectOnboarding";
import { readRelaySignInSession, relaySignInAtom } from "./relaySessionStore";

export function deactivateCloudRelayAccount(): void {
  appAtomRegistry.set(managedRelayAuthLoadAtom, "loaded");
  setAgentAwarenessRelayCredential(null);
  setManagedRelaySession(appAtomRegistry, null);
}

export function activateCloudRelayAccount(session: ManagedRelaySession): void {
  appAtomRegistry.set(managedRelayAuthLoadAtom, "loaded");
  setAgentAwarenessRelayCredential(session.credential);
  setManagedRelaySession(appAtomRegistry, session);
}

function resetManagedRelayTokenCache() {
  return settleAsyncResult(() =>
    runtime.runPromiseExit(
      ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => client.resetTokenCache)),
    ),
  );
}

/**
 * Credential cleanup must finish even when preserving local drafts fails. Sign-out itself
 * removes the device's relay registration before the session ends.
 */
export async function cleanUpCloudRelayAccount(
  removeEnvironments: () => Promise<void>,
): Promise<void> {
  try {
    await removeEnvironments();
  } finally {
    reportAtomCommandResult(await resetManagedRelayTokenCache(), {
      label: "cloud account cleanup",
    });
  }
}

const cleanUpCloudAccount = (accountId: string | null) =>
  cleanUpCloudRelayAccount(async () => {
    const removal = await runAtomCommand(appAtomRegistry, removeCloudEnvironments, accountId, {
      reportFailure: false,
      reportDefect: false,
    });
    if (removal._tag !== "Success") throw squashAtomCommandFailure(removal);
  });

/**
 * The styal Link sign-in as the account service sees it. Loading, moving a Clerk sign-in over,
 * or a failed load is not a sign-out, so only a known sign-in state is reported.
 */
export const relaySignInSource: CloudAccountSource = {
  addListener: (listener) =>
    appAtomRegistry.subscribe(
      relaySignInAtom,
      (state) => {
        if (state.status !== "ready") return;
        const session = state.session;
        const current = cloudAccountService.getState();
        // A new sign-in of the active account keeps its data but needs the new credential.
        if (
          session !== null &&
          current._tag === "Active" &&
          current.accountId === session.accountId
        ) {
          activateCloudRelayAccount(session);
        }
        listener({ user: session === null ? null : { id: session.accountId } });
      },
      { immediate: true },
    ),
};

export const cloudAccountService = createCloudAccountService<CloudAccountSource>({
  deactivate: deactivateCloudRelayAccount,
  // Detaching is not a sign-out: keep lock-screen activities and the persisted registration.
  detach: () => {
    releaseAgentAwarenessRelayCredential();
    setManagedRelaySession(appAtomRegistry, null);
  },
  // A not-yet-presented onboarding request belongs to the account that left.
  onSignOutTransition: clearConnectOnboardingRequest,
  cleanUp: ({ accountId }) => cleanUpCloudAccount(accountId),
  prepare: async ({ accountId, isCurrent }) => {
    try {
      const storedAccount = await getComposerCloudAccountId();
      if (storedAccount !== null && storedAccount !== accountId) {
        await cleanUpCloudAccount(storedAccount);
      }
      if (!isCurrent()) return;
      await restoreCloudComposerDrafts(accountId);
    } catch (error) {
      if (isCurrent()) appAtomRegistry.set(managedRelayAuthLoadAtom, "loaded");
      throw error;
    }
  },
  activate: ({ accountId, isAccountTransition }) => {
    const session = readRelaySignInSession();
    if (session === null || session.accountId !== accountId) return;
    activateCloudRelayAccount(session);
    // Issued after cleanup so the sheet never lists the previous account's environments.
    if (isAccountTransition) requestConnectOnboarding(accountId);
  },
});
