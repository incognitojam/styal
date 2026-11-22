import Constants from "expo-constants";
import { ManagedRelay, managedRelayAuthLoadAtom } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";

import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  resumeAgentAwarenessRegistration,
  setAgentAwarenessRelayCredential,
  stopAgentAwarenessRegistration,
  unregisterAgentAwarenessDeviceForCurrentUser,
} from "../agent-awareness/remoteRegistration";
import { resolveCloudPublicConfig } from "./publicConfig";
import { migrateRelayKeychainAccessibility } from "./relayKeychain";
import {
  beginRelaySessionOperation,
  clearStoredRelaySession,
  finishRelaySessionOperation,
  hasPendingRelaySessionOperation,
  isCurrentRelaySessionOperation,
  loadStoredRelaySession,
  publishRelaySignIn,
  readRelaySignInSession,
  relaySignInAtom,
  saveStoredRelaySession,
  withRelaySessionMutation,
  RelaySessionStoreError,
  type StoredRelaySession,
} from "./relaySessionStore";

/** Shown in the account's signed-in devices list. */
function sessionLabel(): string {
  return (Constants.deviceName?.trim() || "styal mobile").slice(0, 120);
}

const relayClient = ManagedRelay.ManagedRelayClient;

const currentThumbprint = ManagedRelay.ManagedRelayDpopSigner.pipe(
  Effect.flatMap((signer) => signer.thumbprint),
);

const restore = Effect.fn("relaySession.restore")(function* (generation: number) {
  yield* Effect.tryPromise({
    try: () => migrateRelayKeychainAccessibility(),
    catch: (cause) => new RelaySessionStoreError({ operation: "write", cause }),
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not update styal Link keychain accessibility.", { error }),
    ),
  );
  if (!isCurrentRelaySessionOperation(generation)) return null;
  const relayUrl = resolveCloudPublicConfig().relay.url;
  if (relayUrl === null) return { stored: null };
  const stored = yield* loadStoredRelaySession;
  if (!isCurrentRelaySessionOperation(generation)) return null;
  if (stored === null) return { stored: null };
  const thumbprint = yield* currentThumbprint;
  if (!isCurrentRelaySessionOperation(generation)) return null;
  if (stored.relayUrl !== relayUrl || stored.thumbprint !== thumbprint) {
    // Signed in against another relay, or the key it was bound to is gone.
    yield* clearStoredRelaySession;
    return { stored: null };
  }
  return { stored };
});

function markFailed(): void {
  appAtomRegistry.set(relaySignInAtom, { status: "failed" });
  appAtomRegistry.set(managedRelayAuthLoadAtom, "failed");
}

let restoring: Promise<void> | null = null;

/**
 * Loads the saved sign-in. Runs at startup and again on foreground after a
 * failure. It only reads local storage, so it works offline.
 */
export function restoreRelaySession(): Promise<void> {
  if (restoring !== null) return restoring;
  if (appAtomRegistry.get(relaySignInAtom).status === "ready" || hasPendingRelaySessionOperation())
    return Promise.resolve();
  const generation = beginRelaySessionOperation();
  restoring = runtime
    .runPromiseExit(
      withRelaySessionMutation(
        Effect.suspend(() =>
          isCurrentRelaySessionOperation(generation) ? restore(generation) : Effect.succeed(null),
        ),
      ),
    )
    .then((exit) => {
      if (!isCurrentRelaySessionOperation(generation)) return;
      if (exit._tag === "Failure") {
        console.warn("[styal-link] Could not load the saved sign-in", exit.cause);
        markFailed();
        return;
      }
      if (exit.value === null) return;
      publishRelaySignIn(exit.value.stored);
    })
    .finally(() => {
      finishRelaySessionOperation(generation);
      restoring = null;
    });
  return restoring;
}

const saveSignIn = Effect.fnUntraced(function* (
  signIn: ManagedRelay.ManagedRelaySignIn,
  generation: number,
) {
  return yield* withRelaySessionMutation(
    Effect.gen(function* () {
      if (!isCurrentRelaySessionOperation(generation)) return false;
      const relayUrl = resolveCloudPublicConfig().relay.url;
      if (relayUrl === null) return false;
      const thumbprint = yield* currentThumbprint;
      if (!isCurrentRelaySessionOperation(generation)) return false;
      const record: StoredRelaySession = {
        version: 1,
        relayUrl,
        accountId: signIn.credential.accountId,
        email: signIn.email,
        refreshToken: signIn.credential.refreshToken,
        thumbprint,
      };
      yield* saveStoredRelaySession(record);
      if (!isCurrentRelaySessionOperation(generation)) return false;
      resumeAgentAwarenessRegistration();
      publishRelaySignIn(record);
      return true;
    }),
  );
});

export const startEmailSignIn = (email: string) =>
  relayClient.pipe(Effect.flatMap((client) => client.startEmailSignIn({ email })));

// signOut also drops the cached access token, even if the relay cannot be reached.
const discardSignIn = (signIn: ManagedRelay.ManagedRelaySignIn) =>
  relayClient.pipe(
    Effect.flatMap((client) => client.signOut({ credential: signIn.credential })),
    Effect.ignore,
  );

export const verifyEmailSignIn = (input: { readonly email: string; readonly code: string }) =>
  Effect.suspend(() => {
    const generation = beginRelaySessionOperation();
    return Effect.gen(function* () {
      const client = yield* relayClient;
      if (!isCurrentRelaySessionOperation(generation)) return;
      const signIn = yield* client.verifyEmailSignIn({ ...input, label: sessionLabel() });
      const saved = yield* saveSignIn(signIn, generation);
      if (!saved || !isCurrentRelaySessionOperation(generation)) {
        yield* discardSignIn(signIn);
        return;
      }
    }).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          const session = readRelaySignInSession();
          if (session !== null && isCurrentRelaySessionOperation(generation)) {
            resumeAgentAwarenessRegistration();
            setAgentAwarenessRelayCredential(session.credential);
          }
        }),
      ),
      Effect.ensuring(Effect.sync(() => finishRelaySessionOperation(generation))),
    );
  });

/** Stops registration before removing the device and ending this device's session. */
export const signOutOfRelay = Effect.suspend(() => {
  const generation = beginRelaySessionOperation();
  const session = readRelaySignInSession();
  return Effect.gen(function* () {
    yield* stopAgentAwarenessRegistration;
    if (!isCurrentRelaySessionOperation(generation)) return;
    if (session !== null) {
      // Relay requests may await endRelaySession, which takes the mutation lock.
      yield* unregisterAgentAwarenessDeviceForCurrentUser(session.credential);
      if (!isCurrentRelaySessionOperation(generation)) return;
      const client = yield* relayClient;
      yield* client
        .signOut({ credential: session.credential })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not end the styal Link session at the relay.", { error }),
          ),
        );
    }
    yield* withRelaySessionMutation(
      Effect.gen(function* () {
        if (!isCurrentRelaySessionOperation(generation)) return;
        yield* clearStoredRelaySession.pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not remove the saved styal Link sign-in.", { error }),
          ),
        );
        if (!isCurrentRelaySessionOperation(generation)) return;
        publishRelaySignIn(null);
      }),
    );
  }).pipe(Effect.ensuring(Effect.sync(() => finishRelaySessionOperation(generation))));
});

/** Deletes the account after draining registrations and removing this device. */
export const deleteRelayAccount = Effect.suspend(() => {
  const generation = beginRelaySessionOperation();
  const session = readRelaySignInSession();
  return Effect.gen(function* () {
    yield* stopAgentAwarenessRegistration;
    if (session === null || !isCurrentRelaySessionOperation(generation)) return;
    yield* unregisterAgentAwarenessDeviceForCurrentUser(session.credential);
    if (!isCurrentRelaySessionOperation(generation)) return;
    const client = yield* relayClient;
    yield* client.deleteAccount({ credential: session.credential });
    yield* withRelaySessionMutation(
      Effect.gen(function* () {
        if (!isCurrentRelaySessionOperation(generation)) return;
        yield* clearStoredRelaySession.pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not remove the saved styal Link sign-in.", { error }),
          ),
        );
        if (!isCurrentRelaySessionOperation(generation)) return;
        publishRelaySignIn(null);
      }),
    );
  }).pipe(
    Effect.tapError(() =>
      Effect.sync(() => {
        if (
          session !== null &&
          isCurrentRelaySessionOperation(generation) &&
          readRelaySignInSession()?.credential.refreshToken === session.credential.refreshToken
        ) {
          resumeAgentAwarenessRegistration();
          setAgentAwarenessRelayCredential(session.credential);
        }
      }),
    ),
    Effect.ensuring(Effect.sync(() => finishRelaySessionOperation(generation))),
  );
});
