import type { ManagedRelay, ManagedRelaySession } from "@t3tools/client-runtime/relay";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { Atom } from "effect/reactivity";
import * as SecureStore from "expo-secure-store";

import { appAtomRegistry } from "../../state/atom-registry";
import { RELAY_KEYCHAIN_OPTIONS } from "./relayKeychain";

const RELAY_SESSION_STORAGE_KEY = "styal.cloud.relay-session";
// Set once this install has had a relay session; Clerk sign-ins are never moved over after that.
const CLERK_RETIRED_STORAGE_KEY = "styal.cloud.clerk-retired";

const sessionMutationLock = Semaphore.makeUnsafe(1);
let sessionGeneration = 0;
let pendingSessionOperation: number | null = null;

/** Invalidates older requests before this operation starts any asynchronous work. */
export function beginRelaySessionOperation(): number {
  pendingSessionOperation = ++sessionGeneration;
  return sessionGeneration;
}

export function isCurrentRelaySessionOperation(generation: number): boolean {
  return generation === sessionGeneration;
}

export function finishRelaySessionOperation(generation: number): void {
  if (isCurrentRelaySessionOperation(generation)) pendingSessionOperation = null;
}

export function hasPendingRelaySessionOperation(): boolean {
  return pendingSessionOperation !== null;
}

/** Serializes storage and publication so a pending delete cannot erase a newer save. */
export const withRelaySessionMutation = sessionMutationLock.withPermits(1);

/**
 * The styal Link sign-in saved on this device. The refresh token only works
 * with proofs from the DPoP key it was issued to, so a record whose thumbprint
 * no longer matches that key is discarded.
 */
export const StoredRelaySession = Schema.Struct({
  version: Schema.Literal(1),
  relayUrl: Schema.String,
  accountId: Schema.String,
  email: Schema.NullOr(Schema.String),
  refreshToken: Schema.String,
  thumbprint: Schema.String,
});
export type StoredRelaySession = typeof StoredRelaySession.Type;

const StoredRelaySessionJson = Schema.fromJsonString(StoredRelaySession);
const decodeStoredRelaySession = Schema.decodeUnknownEffect(StoredRelaySessionJson);
const encodeStoredRelaySession = Schema.encodeEffect(StoredRelaySessionJson);

export class RelaySessionStoreError extends Data.TaggedError("RelaySessionStoreError")<{
  readonly operation: "read" | "write" | "clear";
  readonly cause: unknown;
}> {}

/** Reads the saved sign-in. An unreadable or malformed record reads as none. */
export const loadStoredRelaySession = Effect.tryPromise({
  try: () => SecureStore.getItemAsync(RELAY_SESSION_STORAGE_KEY, RELAY_KEYCHAIN_OPTIONS),
  catch: (cause) => new RelaySessionStoreError({ operation: "read", cause }),
}).pipe(
  Effect.flatMap((encoded) =>
    encoded === null
      ? Effect.succeed(null)
      : decodeStoredRelaySession(encoded).pipe(Effect.orElseSucceed(() => null)),
  ),
);

export const saveStoredRelaySession = (record: StoredRelaySession) =>
  encodeStoredRelaySession(record).pipe(
    Effect.mapError((cause) => new RelaySessionStoreError({ operation: "write", cause })),
    Effect.flatMap((encoded) =>
      Effect.tryPromise({
        try: () =>
          SecureStore.setItemAsync(RELAY_SESSION_STORAGE_KEY, encoded, RELAY_KEYCHAIN_OPTIONS),
        catch: (cause) => new RelaySessionStoreError({ operation: "write", cause }),
      }),
    ),
  );

export const clearStoredRelaySession = Effect.tryPromise({
  try: () => SecureStore.deleteItemAsync(RELAY_SESSION_STORAGE_KEY, RELAY_KEYCHAIN_OPTIONS),
  catch: (cause) => new RelaySessionStoreError({ operation: "clear", cause }),
});

/**
 * Whether an older Clerk sign-in may still be moved to a relay session. False
 * once this install has had a relay session, so a Clerk sign-out that failed
 * (offline, say) cannot sign the user back in on a later launch.
 */
export const legacyClerkAdoptionAllowed = Effect.tryPromise({
  try: () => SecureStore.getItemAsync(CLERK_RETIRED_STORAGE_KEY, RELAY_KEYCHAIN_OPTIONS),
  catch: (cause) => new RelaySessionStoreError({ operation: "read", cause }),
}).pipe(Effect.map((value) => value === null));

export const retireLegacyClerk = Effect.tryPromise({
  try: () => SecureStore.setItemAsync(CLERK_RETIRED_STORAGE_KEY, "1", RELAY_KEYCHAIN_OPTIONS),
  catch: (cause) => new RelaySessionStoreError({ operation: "write", cause }),
});

/**
 * What this device knows about its styal Link sign-in: "loading" reads the
 * saved record; "adopting" has none and is checking for an older Clerk
 * sign-in to move over; "failed" could not finish either and retries on the
 * next foreground. CloudAuthProvider turns "ready" into the active relay
 * session and ignores the other states, so a pending move never looks like a
 * sign-out.
 */
export type RelaySignInState =
  | { readonly status: "loading" }
  | { readonly status: "adopting" }
  | { readonly status: "failed" }
  | { readonly status: "ready"; readonly session: ManagedRelaySession | null };

export const relaySignInAtom = Atom.make<RelaySignInState>({ status: "loading" }).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:relay-sign-in"),
);

export function sessionFromRecord(record: StoredRelaySession): ManagedRelaySession {
  return {
    accountId: record.accountId,
    email: record.email,
    credential: { accountId: record.accountId, refreshToken: record.refreshToken },
  };
}

/** Publishes the signed-in session, or null for signed out. */
export function publishRelaySignIn(record: StoredRelaySession | null): void {
  const current = appAtomRegistry.get(relaySignInAtom);
  if (
    record !== null &&
    current.status === "ready" &&
    current.session?.accountId === record.accountId &&
    current.session.credential.refreshToken === record.refreshToken &&
    current.session.email === record.email
  ) {
    return;
  }
  appAtomRegistry.set(relaySignInAtom, {
    status: "ready",
    session: record === null ? null : sessionFromRecord(record),
  });
}

export function readRelaySignInSession(): ManagedRelaySession | null {
  const state = appAtomRegistry.get(relaySignInAtom);
  return state.status === "ready" ? state.session : null;
}

/**
 * Drops the saved sign-in when the relay reports that its session ended,
 * unless a newer sign-in has already replaced it.
 */
export const endRelaySession = (credential: ManagedRelay.ManagedRelayCredential) =>
  Effect.suspend(() => {
    const generation = sessionGeneration;
    return withRelaySessionMutation(
      Effect.gen(function* () {
        if (!isCurrentRelaySessionOperation(generation)) return;
        const current = readRelaySignInSession();
        if (current === null || current.credential.refreshToken !== credential.refreshToken) return;
        yield* clearStoredRelaySession.pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not remove the ended styal Link sign-in.", { error }),
          ),
        );
        if (!isCurrentRelaySessionOperation(generation)) return;
        publishRelaySignIn(null);
      }),
    );
  });
