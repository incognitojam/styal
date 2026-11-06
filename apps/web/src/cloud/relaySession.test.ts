import { beforeEach, describe, expect, it } from "@effect/vitest";
import {
  ManagedRelay,
  managedRelayAuthLoadAtom,
  managedRelaySessionAtom,
} from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi } from "vite-plus/test";

import { barrier, makeCloudAuthStorage } from "../../test/cloudAuthStorage";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { interactiveRelaySignInAtom } from "./connectOnboarding";

const state = vi.hoisted(() => ({
  storage: null as ReturnType<typeof makeCloudAuthStorage> | null,
  runExit: null as
    | ((
        effect: Effect.Effect<
          void,
          import("./dpop").BrowserDpopError | ManagedRelay.ManagedRelayDpopKeyLoadError,
          ManagedRelay.ManagedRelayDpopSigner
        >,
      ) => Promise<unknown>)
    | null,
  notify: vi.fn(),
}));
vi.mock("./dpop", async (original) => ({
  ...(await original<typeof import("./dpop")>()),
  cloudAuthTransaction: <A>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore, done: (value: A) => void) => void,
  ) => Effect.suspend(() => state.storage!.transaction(mode, run)),
}));
vi.mock("./publicConfig", () => ({
  resolveCloudPublicConfig: () => ({ relayUrl: "https://relay.example.test" }),
}));
vi.mock("../lib/runtime", () => ({
  runtime: {
    runPromiseExit: (
      effect: Effect.Effect<
        void,
        import("./dpop").BrowserDpopError | ManagedRelay.ManagedRelayDpopKeyLoadError,
        ManagedRelay.ManagedRelayDpopSigner
      >,
    ) => state.runExit!(effect),
  },
}));

import {
  adoptClerkSession,
  deleteRelayAccount,
  restoreRelaySession,
  setLegacyClerkSignOut,
  signOutOfRelay,
  verifyEmailSignIn,
} from "./relaySession";
import {
  endRelaySession,
  publishRelaySession,
  updateRelaySessionState,
  watchOtherTabs,
  type StoredRelaySession,
} from "./relaySessionStore";

function record(id: string): StoredRelaySession {
  return {
    version: 1,
    relayUrl: "https://relay.example.test",
    accountId: id,
    email: `${id}@example.test`,
    refreshToken: `synthetic-${id}`,
    thumbprint: "synthetic-key",
  };
}
function signIn(id: string) {
  return {
    credential: { accountId: id, refreshToken: `synthetic-${id}` },
    email: `${id}@example.test`,
  };
}
const exchange = vi.fn(() => Effect.succeed(signIn("old-account")));
const verify = vi.fn(() => Effect.succeed(signIn("new-account")));
const revoke = vi.fn(() => Effect.void);
const remove = vi.fn(() => Effect.void);
const thumbprint = vi.fn(() => Effect.succeed("synthetic-key"));
const client = {
  verifyEmailSignIn: verify,
  exchangeClerkSession: exchange,
  signOut: revoke,
  deleteAccount: remove,
};
const provide = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ManagedRelay.ManagedRelayClient | ManagedRelay.ManagedRelayDpopSigner
  >,
) =>
  effect.pipe(
    Effect.provideService(
      ManagedRelay.ManagedRelayClient,
      client as unknown as ManagedRelay.ManagedRelayClient["Service"],
    ),
    Effect.provideService(ManagedRelay.ManagedRelayDpopSigner, {
      thumbprint: Effect.suspend(thumbprint),
      createProof: () => Effect.succeed("synthetic-proof"),
    }),
  );
const emailSignIn = () =>
  provide(verifyEmailSignIn({ email: "new-account@example.test", code: "12345678" }));
function expectCurrent(id: string | null) {
  expect(state.storage!.records.get("relay-session")).toEqual(id === null ? undefined : record(id));
  expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId ?? null).toBe(id);
}

beforeEach(() => {
  state.storage = makeCloudAuthStorage();
  state.notify.mockReset().mockImplementation(() => {
    // Every notification observes both writes after the transaction committed.
    expect(state.storage!.records.get("relay-session-clerk-retired")).toBe(true);
  });
  vi.stubGlobal("navigator", { platform: "synthetic-browser" });
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      addEventListener() {}
      postMessage() {
        state.notify();
      }
    },
  );
  watchOtherTabs(() => undefined);
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Exercise the real Promise-based startup entry point using the same test services.
  state.runExit = (effect) => Effect.runPromiseExit(provide(effect));
  exchange.mockImplementation(() => Effect.succeed(signIn("old-account")));
  verify.mockImplementation(() => Effect.succeed(signIn("new-account")));
  revoke.mockClear();
  remove.mockImplementation(() => Effect.void);
  thumbprint.mockImplementation(() => Effect.succeed("synthetic-key"));
  setLegacyClerkSignOut(null);
  publishRelaySession(null);
  appAtomRegistry.set(interactiveRelaySignInAtom, null);
  appAtomRegistry.set(managedRelayAuthLoadAtom, "loading");
});

describe("relay session lifecycle", () => {
  it.effect("discards and signs out a delayed adoption after an email sign-in wins", () =>
    Effect.gen(function* () {
      const pending = barrier();
      exchange.mockImplementation(() =>
        Effect.promise(async () => {
          await pending.wait();
          return signIn("old-account");
        }),
      );
      const adoption = yield* provide(adoptClerkSession("synthetic-clerk-token")).pipe(
        Effect.forkChild,
      );
      yield* Effect.promise(() => pending.entered);
      expect(yield* emailSignIn()).toBe(true);
      pending.release();
      yield* Fiber.join(adoption);
      expectCurrent("new-account");
      expect(revoke).toHaveBeenCalledWith({ credential: signIn("old-account").credential });
    }),
  );

  it.effect("cannot resurrect an exchanged session after explicit sign-out", () =>
    Effect.gen(function* () {
      const pending = barrier();
      exchange.mockImplementation(() =>
        Effect.promise(async () => {
          await pending.wait();
          return signIn("old-account");
        }),
      );
      const adoption = yield* provide(adoptClerkSession("synthetic-clerk-token")).pipe(
        Effect.forkChild,
      );
      yield* Effect.promise(() => pending.entered);
      yield* emailSignIn();
      yield* provide(signOutOfRelay);
      pending.release();
      yield* Fiber.join(adoption);
      expectCurrent(null);
      expect(state.storage!.records.get("relay-session-clerk-retired")).toBe(true);
    }),
  );

  it.effect("does not publish a stale restore after resolving its key", () =>
    Effect.gen(function* () {
      state.storage!.records.set("relay-session", record("old-account"));
      const pending = barrier();
      thumbprint.mockImplementationOnce(() =>
        Effect.promise(async () => {
          await pending.wait();
          return "synthetic-key";
        }),
      );
      const restoring = restoreRelaySession();
      yield* Effect.promise(() => pending.entered);
      yield* emailSignIn();
      pending.release();
      yield* Effect.promise(() => restoring);
      expectCurrent("new-account");
    }),
  );

  it.effect("a sign-out invalidates a delayed email verification", () =>
    Effect.gen(function* () {
      const pending = barrier();
      verify.mockImplementation(() =>
        Effect.promise(async () => {
          await pending.wait();
          return signIn("new-account");
        }),
      );
      const verifying = yield* emailSignIn().pipe(Effect.forkChild);
      yield* Effect.promise(() => pending.entered);
      yield* provide(signOutOfRelay);
      pending.release();
      expect(yield* Fiber.join(verifying)).toBe(false);
      expectCurrent(null);
      expect(appAtomRegistry.get(interactiveRelaySignInAtom)).toBeNull();
      expect(revoke).toHaveBeenCalledWith({ credential: signIn("new-account").credential });
    }),
  );

  it.effect("preserves another tab's winner during ended-session cleanup", () =>
    Effect.gen(function* () {
      state.storage!.records.set("relay-session", record("old-account"));
      publishRelaySession(record("old-account"));
      yield* updateRelaySessionState(() => ({
        session: record("new-account"),
        clerkRetired: true,
      }));
      yield* endRelaySession(signIn("old-account").credential);
      expectCurrent("new-account");
      const cleanup = state.storage!.transactions.at(-2)!;
      expect(cleanup.mode).toBe("readwrite");
      expect(cleanup.writes).toEqual([]);
    }),
  );

  it.effect("compares and deletes in one transaction while a replacement waits", () =>
    Effect.gen(function* () {
      state.storage!.records.set("relay-session", record("old-account"));
      publishRelaySession(record("old-account"));
      const pending = barrier();
      state.storage!.pauseNextCommit(pending.wait);
      const ending = yield* endRelaySession(signIn("old-account").credential).pipe(
        Effect.forkChild,
      );
      yield* Effect.promise(() => pending.entered);
      const signingIn = yield* emailSignIn().pipe(Effect.forkChild);
      pending.release();
      yield* Fiber.join(ending);
      yield* Fiber.join(signingIn);
      expectCurrent("new-account");
      expect(state.storage!.transactions[0]!.writes).toContain("relay-session");
    }),
  );

  it.effect("does not invalidate a pending sign-in when an already-absent session ends", () =>
    Effect.gen(function* () {
      const pending = barrier();
      verify.mockImplementation(() =>
        Effect.promise(async () => {
          await pending.wait();
          return signIn("new-account");
        }),
      );
      const verifying = yield* emailSignIn().pipe(Effect.forkChild);
      yield* Effect.promise(() => pending.entered);
      yield* endRelaySession(signIn("old-account").credential);
      pending.release();
      expect(yield* Fiber.join(verifying)).toBe(true);
      expectCurrent("new-account");
    }),
  );

  it.effect("lets a pending replacement finish after the old credential ends", () =>
    Effect.gen(function* () {
      state.storage!.records.set("relay-session", record("old-account"));
      publishRelaySession(record("old-account"));
      const pending = barrier();
      verify.mockImplementation(() =>
        Effect.promise(async () => {
          await pending.wait();
          return signIn("new-account");
        }),
      );
      const verifying = yield* emailSignIn().pipe(Effect.forkChild);
      yield* Effect.promise(() => pending.entered);
      yield* endRelaySession(signIn("old-account").credential);
      expectCurrent(null);
      pending.release();
      expect(yield* Fiber.join(verifying)).toBe(true);
      expectCurrent("new-account");
    }),
  );

  it.effect("keeps a newer sign-in when account deletion finishes late", () =>
    Effect.gen(function* () {
      state.storage!.records.set("relay-session", record("old-account"));
      publishRelaySession(record("old-account"));
      const pending = barrier();
      remove.mockImplementation(() => Effect.promise(pending.wait));
      const deleting = yield* provide(deleteRelayAccount).pipe(Effect.forkChild);
      yield* Effect.promise(() => pending.entered);
      yield* emailSignIn();
      pending.release();
      yield* Fiber.join(deleting);
      expectCurrent("new-account");
      expect(remove).toHaveBeenCalledWith({ credential: signIn("old-account").credential });
    }),
  );

  it.effect("commits the credential and retirement marker together before notifying", () =>
    Effect.gen(function* () {
      yield* emailSignIn();
      expectCurrent("new-account");
      expect(state.notify).toHaveBeenCalled();
      expect(
        state
          .storage!.transactions.filter((entry) => entry.writes.includes("relay-session"))
          .every((entry) => entry.writes.includes("relay-session-clerk-retired")),
      ).toBe(true);
      expect(appAtomRegistry.get(interactiveRelaySignInAtom)).toEqual({ accountId: "new-account" });
    }),
  );

  it.effect("never publishes a sign-in removed by another tab after its commit", () =>
    Effect.gen(function* () {
      state.notify.mockImplementation(() => {
        if (state.storage!.records.has("relay-session")) {
          state.storage!.records.delete("relay-session");
          state.storage!.records.set(
            "relay-session-revision",
            Number(state.storage!.records.get("relay-session-revision")) + 1,
          );
        }
      });
      expect(yield* emailSignIn()).toBe(false);
      expectCurrent(null);
      expect(appAtomRegistry.get(interactiveRelaySignInAtom)).toBeNull();
    }),
  );

  it.effect("rejects an adoption superseded by a different tab's persisted generation", () =>
    Effect.gen(function* () {
      const pending = barrier();
      exchange.mockImplementation(() =>
        Effect.promise(async () => {
          await pending.wait();
          return signIn("old-account");
        }),
      );
      const adoption = yield* provide(adoptClerkSession("synthetic-clerk-token")).pipe(
        Effect.forkChild,
      );
      yield* Effect.promise(() => pending.entered);
      yield* updateRelaySessionState(() => ({
        session: record("new-account"),
        clerkRetired: true,
      }));
      publishRelaySession(record("new-account"));
      pending.release();
      yield* Fiber.join(adoption);
      expectCurrent("new-account");
      expect(revoke).toHaveBeenCalledWith({ credential: signIn("old-account").credential });
    }),
  );

  it.effect("adopts silently and retires Clerk without requesting onboarding", () =>
    Effect.gen(function* () {
      const clerkSignOut = vi.fn(async () => undefined);
      setLegacyClerkSignOut(clerkSignOut);
      yield* provide(adoptClerkSession("synthetic-clerk-token"));
      expectCurrent("old-account");
      expect(appAtomRegistry.get(interactiveRelaySignInAtom)).toBeNull();
      expect(clerkSignOut).toHaveBeenCalledOnce();
    }),
  );

  it.effect("uses Web Locks when available and the transaction fallback otherwise", () =>
    Effect.gen(function* () {
      const request = vi.fn(
        async (_name: string, _options: unknown, callback: () => Promise<void>) => {
          await callback();
        },
      );
      vi.stubGlobal("navigator", { platform: "synthetic-browser", locks: { request } });
      yield* emailSignIn();
      expect(request).toHaveBeenCalled();
      expectCurrent("new-account");
      vi.stubGlobal("navigator", { platform: "synthetic-browser" });
      yield* provide(signOutOfRelay);
      expectCurrent(null);
    }),
  );
});
