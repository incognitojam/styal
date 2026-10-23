import { ManagedRelay, managedRelayAuthLoadAtom } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";

import { isElectron } from "../env";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { interactiveRelaySignInAtom } from "./connectOnboarding";
import { resolveCloudPublicConfig } from "./publicConfig";
import {
  readRelaySessionState,
  updateRelaySessionState,
  publishRelaySessionIfCurrent,
  type StoredRelaySession,
  watchOtherTabs,
  withRelaySessionLock,
} from "./relaySessionStore";

/** Shown in the account's signed-in devices list. */
function sessionLabel(): string {
  if (isElectron) return "styal desktop";
  const platform = navigator.platform || "browser";
  return `styal web on ${platform}`.slice(0, 120);
}

const relayClient = ManagedRelay.ManagedRelayClient;
const currentThumbprint = ManagedRelay.ManagedRelayDpopSigner.pipe(
  Effect.flatMap((signer) => signer.thumbprint),
);

const restore = Effect.gen(function* () {
  const relayUrl = resolveCloudPublicConfig().relayUrl;
  const snapshot = yield* withRelaySessionLock(readRelaySessionState);
  const thumbprint =
    snapshot.session !== null && relayUrl !== null ? yield* currentThumbprint : null;
  yield* withRelaySessionLock(
    Effect.gen(function* () {
      const { state } = yield* updateRelaySessionState((current) => {
        if (current.revision !== snapshot.revision) return null;
        if (
          current.session !== null &&
          (current.session.relayUrl !== relayUrl || current.session.thumbprint !== thumbprint)
        )
          return { session: null, clerkRetired: true };
        return null;
      });
      // A restore from before a new intent must not publish its old snapshot.
      if (
        state.revision === snapshot.revision ||
        state.session === null ||
        (state.session.relayUrl === relayUrl && state.session.thumbprint === thumbprint)
      )
        yield* publishRelaySessionIfCurrent(state.revision);
    }),
  );
});

/** Restores offline, at startup and after another tab commits a lifecycle change. */
export function restoreRelaySession(): Promise<void> {
  watchOtherTabs(() => void restoreRelaySession());
  return runtime.runPromiseExit(restore).then((exit) => {
    if (exit._tag === "Failure" && appAtomRegistry.get(managedRelayAuthLoadAtom) !== "loaded")
      appAtomRegistry.set(managedRelayAuthLoadAtom, "failed");
  });
}

const beginInteractiveChange = withRelaySessionLock(
  updateRelaySessionState((state) => ({
    session: state.session,
    clerkRetired: true,
    generation: state.generation + 1,
  })),
).pipe(Effect.map(({ state }) => state));

const saveSignIn = Effect.fnUntraced(function* (
  signIn: ManagedRelay.ManagedRelaySignIn,
  generation: number,
  interactive: boolean,
) {
  const relayUrl = resolveCloudPublicConfig().relayUrl;
  if (relayUrl === null) return false;
  const record: StoredRelaySession = {
    version: 1,
    relayUrl,
    accountId: signIn.credential.accountId,
    email: signIn.email,
    refreshToken: signIn.credential.refreshToken,
    thumbprint: yield* currentThumbprint,
  };
  return yield* withRelaySessionLock(
    Effect.gen(function* () {
      const { changed, state } = yield* updateRelaySessionState((state) =>
        state.generation === generation &&
        (interactive || (!state.clerkRetired && state.session === null))
          ? { session: record, clerkRetired: true }
          : null,
      );
      if (!changed) return false;
      return yield* publishRelaySessionIfCurrent(state.revision, () => {
        if (interactive)
          appAtomRegistry.set(interactiveRelaySignInAtom, { accountId: record.accountId });
      });
    }),
  );
});

export const startEmailSignIn = (email: string) =>
  relayClient.pipe(Effect.flatMap((client) => client.startEmailSignIn({ email })));

const discardSignIn = (signIn: ManagedRelay.ManagedRelaySignIn) =>
  relayClient.pipe(
    Effect.flatMap((client) => client.signOut({ credential: signIn.credential })),
    Effect.ignore,
  );

export const verifyEmailSignIn = (input: { readonly email: string; readonly code: string }) =>
  Effect.gen(function* () {
    const { generation } = yield* beginInteractiveChange;
    const client = yield* relayClient;
    const signIn = yield* client.verifyEmailSignIn({ ...input, label: sessionLabel() });
    const saved = yield* saveSignIn(signIn, generation, true);
    if (saved) yield* signOutOfLegacyClerk;
    else yield* discardSignIn(signIn);
    return saved;
  });

let legacyClerkSignOut: (() => Promise<void>) | null = null;

/** Registered while Clerk is mounted, so leaving styal Link also leaves Clerk. */
export function setLegacyClerkSignOut(signOut: (() => Promise<void>) | null): void {
  legacyClerkSignOut = signOut;
}

const signOutOfLegacyClerk = Effect.promise(async () => {
  await legacyClerkSignOut?.().catch(() => undefined);
});

/** Moves a Clerk sign-in silently, provided no newer lifecycle intent won. */
export const adoptClerkSession = (clerkToken: string) =>
  Effect.gen(function* () {
    const snapshot = yield* withRelaySessionLock(readRelaySessionState);
    if (snapshot.session !== null || snapshot.clerkRetired) return;
    const client = yield* relayClient;
    const signIn = yield* client.exchangeClerkSession({ clerkToken, label: sessionLabel() });
    if (yield* saveSignIn(signIn, snapshot.generation, false)) yield* signOutOfLegacyClerk;
    else yield* discardSignIn(signIn);
  });

const clearIfCurrent = (generation: number) =>
  withRelaySessionLock(
    Effect.gen(function* () {
      const { state, changed } = yield* updateRelaySessionState((current) =>
        current.generation === generation ? { session: null, clerkRetired: true } : null,
      );
      if (changed) {
        yield* publishRelaySessionIfCurrent(state.revision);
      }
    }),
  );

/** Removes the local sign-in even when remote sign-out fails. */
export const signOutOfRelay = Effect.gen(function* () {
  const { session, generation } = yield* beginInteractiveChange;
  yield* signOutOfLegacyClerk;
  yield* clearIfCurrent(generation);
  if (session !== null) {
    const client = yield* relayClient;
    yield* client
      .signOut({ credential: { accountId: session.accountId, refreshToken: session.refreshToken } })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not end the styal Link session at the relay.", { error }),
        ),
      );
  }
});

/** Deletes the captured account without clearing a newer sign-in. */
export const deleteRelayAccount = Effect.gen(function* () {
  const { session, generation } = yield* beginInteractiveChange;
  if (session === null) return;
  const client = yield* relayClient;
  yield* client.deleteAccount({
    credential: { accountId: session.accountId, refreshToken: session.refreshToken },
  });
  yield* signOutOfLegacyClerk;
  yield* clearIfCurrent(generation);
});
