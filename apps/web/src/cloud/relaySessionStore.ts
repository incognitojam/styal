import {
  type ManagedRelay,
  managedRelayAuthLoadAtom,
  setManagedRelaySession,
} from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { BrowserDpopError, cloudAuthTransaction } from "./dpop";

const RECORD_KEY = "relay-session";
const CLERK_RETIRED_KEY = "relay-session-clerk-retired";
const REVISION_KEY = "relay-session-revision";
const GENERATION_KEY = "relay-session-generation";
const CHANNEL_NAME = "styal:relay-session";

/** The credential and the thumbprint of the non-extractable key it requires. */
export const StoredRelaySession = Schema.Struct({
  version: Schema.Literal(1),
  relayUrl: Schema.String,
  accountId: Schema.String,
  email: Schema.NullOr(Schema.String),
  refreshToken: Schema.String,
  thumbprint: Schema.String,
});
export type StoredRelaySession = typeof StoredRelaySession.Type;
const isStoredRelaySession = Schema.is(StoredRelaySession);

export interface RelaySessionState {
  readonly session: StoredRelaySession | null;
  readonly clerkRetired: boolean;
  readonly revision: number;
  readonly generation: number;
}

function readState(store: IDBObjectStore, done: (state: RelaySessionState) => void): void {
  const session = store.get(RECORD_KEY);
  const retired = store.get(CLERK_RETIRED_KEY);
  const revision = store.get(REVISION_KEY);
  const generation = store.get(GENERATION_KEY);
  generation.addEventListener("success", () =>
    done({
      session: isStoredRelaySession(session.result) ? session.result : null,
      clerkRetired: retired.result === true,
      revision: typeof revision.result === "number" ? revision.result : 0,
      generation: typeof generation.result === "number" ? generation.result : 0,
    }),
  );
}

export const readRelaySessionState = cloudAuthTransaction<RelaySessionState>("readonly", readState);

/**
 * The revision check and all writes share one transaction, including without
 * Web Locks. User actions reserve a generation before network work; cleanup
 * advances the storage revision without cancelling those pending actions.
 */
export const updateRelaySessionState = (
  update: (
    state: RelaySessionState,
  ) =>
    | (Pick<RelaySessionState, "session" | "clerkRetired"> & { readonly generation?: number })
    | null,
) =>
  cloudAuthTransaction<{ readonly state: RelaySessionState; readonly changed: boolean }>(
    "readwrite",
    (store, done) => {
      readState(store, (previous) => {
        const next = update(previous);
        if (next === null) {
          done({ state: previous, changed: false });
          return;
        }
        const state = {
          ...next,
          generation: next.generation ?? previous.generation,
          revision: previous.revision + 1,
        };
        if (state.session === null) store.delete(RECORD_KEY);
        else store.put(state.session, RECORD_KEY);
        store.put(state.clerkRetired, CLERK_RETIRED_KEY);
        store.put(state.revision, REVISION_KEY);
        store.put(state.generation, GENERATION_KEY);
        done({ state, changed: true });
      });
    },
  ).pipe(
    Effect.tap(({ state, changed }) =>
      Effect.sync(() => {
        if (changed) notifyOtherTabs(state.revision);
      }),
    ),
  );

const lifecycleLock = Semaphore.makeUnsafe(1);

/** Serializes local lifecycle stages and holds a cross-tab lock through publication. */
export function withRelaySessionLock<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return lifecycleLock
    .withPermit(
      Effect.suspend(() => {
        if (typeof navigator === "undefined" || !navigator.locks) return effect;
        const acquire = Effect.callback<() => void, BrowserDpopError>((resume, signal) => {
          let release!: () => void;
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          void navigator.locks
            .request(CHANNEL_NAME, { signal }, () => {
              resume(Effect.succeed(release));
              return held;
            })
            .catch((cause: unknown) =>
              resume(
                Effect.fail(
                  new BrowserDpopError({
                    message: "Could not lock styal Link sign-in storage.",
                    cause,
                  }),
                ),
              ),
            );
        });
        return Effect.acquireUseRelease(
          acquire,
          () => effect,
          (release) => Effect.sync(release),
        );
      }),
    )
    .pipe(Effect.uninterruptible);
}

export function publishRelaySession(record: StoredRelaySession | null): void {
  setManagedRelaySession(
    appAtomRegistry,
    record === null
      ? null
      : {
          accountId: record.accountId,
          email: record.email,
          credential: { accountId: record.accountId, refreshToken: record.refreshToken },
        },
  );
}

/**
 * Publish while the read transaction excludes writers, including in browsers
 * without Web Locks. A commit completed before this callback is authoritative.
 */
export const publishRelaySessionIfCurrent = (revision: number, onPublish?: () => void) =>
  cloudAuthTransaction<boolean>("readonly", (store, done) => {
    readState(store, (state) => {
      const current = state.revision === revision;
      if (current) {
        publishRelaySession(state.session);
        appAtomRegistry.set(managedRelayAuthLoadAtom, "loaded");
        onPublish?.();
      }
      done(current);
    });
  });

/** Compare-and-delete cannot remove another tab's replacement credential. */
export const endRelaySession = (credential: ManagedRelay.ManagedRelayCredential) =>
  withRelaySessionLock(
    Effect.gen(function* () {
      const { state } = yield* updateRelaySessionState((current) =>
        current.session !== null &&
        current.session.accountId === credential.accountId &&
        current.session.refreshToken === credential.refreshToken
          ? { session: null, clerkRetired: true }
          : null,
      );
      yield* publishRelaySessionIfCurrent(state.revision);
    }),
  ).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not clear the ended styal Link session.", { error }),
    ),
  );

let channel: BroadcastChannel | null = null;
let watching = false;

function notifyOtherTabs(revision: number): void {
  if (channel !== null) {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel accepts no target origin.
    channel.postMessage("changed");
  } else if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(CHANNEL_NAME, String(revision));
    } catch {
      /* Storage may be disabled. */
    }
  }
}

/** Broadcast only committed changes; storage events cover older browsers. */
export function watchOtherTabs(reload: () => void): void {
  if (watching) return;
  watching = true;
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener("message", reload);
  } else if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      if (event.key === CHANNEL_NAME) reload();
    });
  }
}

/** A failed Clerk sign-out must never undo an explicit relay sign-out. */
export const legacyClerkAdoptionAllowed = readRelaySessionState.pipe(
  Effect.map((state) => !state.clerkRetired && state.session === null),
);
