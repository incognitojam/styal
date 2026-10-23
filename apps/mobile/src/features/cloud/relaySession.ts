import Constants from "expo-constants";
import { ManagedRelay, managedRelayAuthLoadAtom } from "@t3tools/client-runtime/relay";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  resumeAgentAwarenessRegistration,
  setAgentAwarenessRelayCredential,
  stopAgentAwarenessRegistration,
  unregisterAgentAwarenessDeviceForCurrentUser,
} from "../agent-awareness/remoteRegistration";
import { hasLegacyClerkConfig, resolveCloudPublicConfig } from "./publicConfig";
import { migrateRelayKeychainAccessibility } from "./relayKeychain";
import {
  beginRelaySessionOperation,
  clearStoredRelaySession,
  finishRelaySessionOperation,
  hasPendingRelaySessionOperation,
  isCurrentRelaySessionOperation,
  legacyClerkAdoptionAllowed,
  loadStoredRelaySession,
  publishRelaySignIn,
  readRelaySignInSession,
  relaySignInAtom,
  retireLegacyClerk,
  saveStoredRelaySession,
  withRelaySessionMutation,
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

const restore = (generation: number) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => migrateRelayKeychainAccessibility()).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not update styal Link keychain accessibility.", { error }),
      ),
    );
    if (!isCurrentRelaySessionOperation(generation)) return null;
    const relayUrl = resolveCloudPublicConfig().relay.url;
    if (relayUrl === null) return { stored: null, adoptClerk: false };
    const stored = yield* loadStoredRelaySession;
    if (!isCurrentRelaySessionOperation(generation)) return null;
    if (stored === null) {
      return {
        stored: null,
        adoptClerk: hasLegacyClerkConfig() && (yield* legacyClerkAdoptionAllowed),
      };
    }
    const thumbprint = yield* currentThumbprint;
    if (!isCurrentRelaySessionOperation(generation)) return null;
    if (stored.relayUrl !== relayUrl || stored.thumbprint !== thumbprint) {
      // Signed in against another relay, or the key it was bound to is gone.
      yield* clearStoredRelaySession;
      return { stored: null, adoptClerk: false };
    }
    return { stored, adoptClerk: false };
  });

function markFailed(): void {
  appAtomRegistry.set(relaySignInAtom, { status: "failed" });
  appAtomRegistry.set(managedRelayAuthLoadAtom, "failed");
}

let restoring: Promise<void> | null = null;

/**
 * Loads the saved sign-in. Runs at startup and again on foreground after a
 * failure. It only reads local storage, so it works offline. Without a saved
 * sign-in, a build that still has Clerk settings moves to "adopting" so an
 * older Clerk sign-in can be moved over first.
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
      if (exit.value.adoptClerk) {
        // Adoption starts its own operation and skips while one is pending, and
        // it can react to "adopting" right away, so finish this one first.
        finishRelaySessionOperation(generation);
        appAtomRegistry.set(relaySignInAtom, { status: "adopting" });
        return;
      }
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
      yield* retireLegacyClerk.pipe(
        Effect.catch((error) => Effect.logWarning("Could not record the Clerk move.", { error })),
      );
      if (!isCurrentRelaySessionOperation(generation)) return false;
      resumeAgentAwarenessRegistration();
      publishRelaySignIn(record);
      return true;
    }),
  );
});

let legacyClerkSignOut: (() => Promise<void>) | null = null;

/** Registered while Clerk is mounted, so leaving styal Link also leaves Clerk. */
export function setLegacyClerkSignOut(signOut: (() => Promise<void>) | null): void {
  legacyClerkSignOut = signOut;
}

const signOutOfLegacyClerk = Effect.promise(async () => {
  await legacyClerkSignOut?.().catch(() => undefined);
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
      yield* signOutOfLegacyClerk;
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

/** Only an explicit rejection of the Clerk bearer establishes that it cannot be moved. */
function isClerkCredentialRejected(error: unknown): boolean {
  if (!(error instanceof ManagedRelay.ManagedRelayRequestFailedError)) return false;
  return (
    error.transportFailed !== true &&
    error.relayError?._tag === "RelayAuthInvalidError" &&
    error.relayError.reason === "invalid_bearer"
  );
}

let adoptingGeneration: number | null = null;

/** Moves an older Clerk sign-in, retaining it when local or relay work can be retried. */
export async function adoptClerkSession(readClerkToken: () => Promise<string | null>) {
  if (
    appAtomRegistry.get(relaySignInAtom).status !== "adopting" ||
    hasPendingRelaySessionOperation()
  )
    return;
  const generation = beginRelaySessionOperation();
  adoptingGeneration = generation;
  try {
    const clerkToken = await readClerkToken().catch(() => undefined);
    if (!isCurrentRelaySessionOperation(generation)) return;
    if (clerkToken == null) {
      markFailed();
      return;
    }
    const exit = await runtime.runPromiseExit(
      relayClient.pipe(
        Effect.flatMap((client) =>
          isCurrentRelaySessionOperation(generation)
            ? client.exchangeClerkSession({ clerkToken, label: sessionLabel() })
            : Effect.succeed(null),
        ),
        Effect.flatMap((signIn) =>
          Effect.gen(function* () {
            if (signIn === null) return;
            const saved = yield* saveSignIn(signIn, generation);
            if (!saved || !isCurrentRelaySessionOperation(generation)) yield* discardSignIn(signIn);
          }),
        ),
      ),
    );
    if (!isCurrentRelaySessionOperation(generation)) return;
    if (exit._tag === "Success") {
      await runtime.runPromise(signOutOfLegacyClerk);
      return;
    }
    console.warn("[styal-link] Could not move the Clerk sign-in to the relay", exit.cause);
    if (!isClerkCredentialRejected(Cause.squash(exit.cause))) {
      markFailed();
      return;
    }
    await runtime.runPromise(signOutOfLegacyClerk);
    if (!isCurrentRelaySessionOperation(generation)) return;
    await runtime.runPromise(
      withRelaySessionMutation(
        Effect.sync(() => {
          if (isCurrentRelaySessionOperation(generation)) publishRelaySignIn(null);
        }),
      ),
    );
  } finally {
    if (adoptingGeneration === generation) adoptingGeneration = null;
    finishRelaySessionOperation(generation);
  }
}

/** Settles adoption when Clerk has confirmed there is no sign-in to move. */
export function finishClerkAdoptionSignedOut(): Promise<void> {
  if (appAtomRegistry.get(relaySignInAtom).status !== "adopting") return Promise.resolve();
  if (
    hasPendingRelaySessionOperation() &&
    (adoptingGeneration === null || !isCurrentRelaySessionOperation(adoptingGeneration))
  )
    return Promise.resolve();
  const generation = beginRelaySessionOperation();
  return runtime
    .runPromise(
      withRelaySessionMutation(
        Effect.sync(() => {
          if (isCurrentRelaySessionOperation(generation)) publishRelaySignIn(null);
        }),
      ),
    )
    .finally(() => finishRelaySessionOperation(generation));
}

/** Cancels a pending move when Clerk cannot load, allowing explicit email sign-in. */
export function failClerkAdoption(): void {
  if (appAtomRegistry.get(relaySignInAtom).status !== "adopting") return;
  if (
    hasPendingRelaySessionOperation() &&
    (adoptingGeneration === null || !isCurrentRelaySessionOperation(adoptingGeneration))
  )
    return;
  finishRelaySessionOperation(beginRelaySessionOperation());
  markFailed();
}

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
    if (isCurrentRelaySessionOperation(generation)) yield* signOutOfLegacyClerk;
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
    if (isCurrentRelaySessionOperation(generation)) yield* signOutOfLegacyClerk;
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
