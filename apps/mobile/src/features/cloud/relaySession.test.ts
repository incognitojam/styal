import { ManagedRelay, managedRelayAuthLoadAtom } from "@t3tools/client-runtime/relay";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { RelayAuthInvalidError } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import type * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as SecureStore from "expo-secure-store";
import { beforeEach, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  setAgentAwarenessRelayCredential,
  unregisterAgentAwarenessDeviceForCurrentUser,
} from "../agent-awareness/remoteRegistration";
import {
  adoptClerkSession,
  deleteRelayAccount,
  failClerkAdoption,
  finishClerkAdoptionSignedOut,
  restoreRelaySession,
  setLegacyClerkSignOut,
  signOutOfRelay,
  verifyEmailSignIn,
} from "./relaySession";
import { endRelaySession, relaySignInAtom } from "./relaySessionStore";

const SESSION_KEY = "styal.cloud.relay-session";
const RELAY_URL = "https://relay.example.test";

const secureStore = vi.hoisted(() => new Map<string, string>());
const calls = vi.hoisted(() => [] as Array<string>);
const config = vi.hoisted(() => ({
  extra: {} as Record<string, unknown>,
}));
const fakes = vi.hoisted(() => ({
  client: null as unknown,
  signer: null as unknown,
}));

vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "after-first-unlock-this-device-only",
  getItemAsync: vi.fn((key: string) => Promise.resolve(secureStore.get(key) ?? null)),
  setItemAsync: vi.fn((key: string, value: string) => {
    secureStore.set(key, value);
    return Promise.resolve();
  }),
  deleteItemAsync: vi.fn((key: string) => {
    calls.push(`delete:${key}`);
    secureStore.delete(key);
    return Promise.resolve();
  }),
}));

vi.mock("expo-constants", () => ({
  default: {
    deviceName: "Test iPhone",
    get expoConfig() {
      return { extra: config.extra };
    },
  },
}));

vi.mock("../agent-awareness/remoteRegistration", () => ({
  unregisterAgentAwarenessDeviceForCurrentUser: vi.fn(),
  stopAgentAwarenessRegistration: Effect.sync(() => {
    calls.push("stop-registration");
  }),
  setAgentAwarenessRelayCredential: vi.fn(),
  resumeAgentAwarenessRegistration: vi.fn(),
}));

interface RuntimeRequest {
  readonly operation: Effect.Effect<unknown, unknown, unknown>;
  readonly resolve: (exit: Exit.Exit<unknown, unknown>) => void;
}
const runtimeRequests = vi.hoisted(() => ({
  pending: [] as RuntimeRequest[],
  enqueue: null as ((request: RuntimeRequest) => void) | null,
}));

vi.mock("../../lib/runtime", () => ({
  runtime: {
    runPromiseExit: (operation: RuntimeRequest["operation"]) =>
      new Promise((resolve) => {
        const request = { operation, resolve };
        if (runtimeRequests.enqueue) runtimeRequests.enqueue(request);
        else runtimeRequests.pending.push(request);
      }),
    runPromise: (operation: RuntimeRequest["operation"]) =>
      new Promise((resolve, reject) => {
        const request = {
          operation,
          resolve: (exit: Exit.Exit<unknown, unknown>) =>
            exit._tag === "Success" ? resolve(exit.value) : reject(exit.cause),
        };
        if (runtimeRequests.enqueue) runtimeRequests.enqueue(request);
        else runtimeRequests.pending.push(request);
      }),
  },
}));

const signIn = {
  credential: { accountId: "account-1", refreshToken: "styal_rt_session_secret" },
  email: "someone@example.com",
};

function storedRecord(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    relayUrl: RELAY_URL,
    accountId: "account-1",
    email: "someone@example.com",
    refreshToken: "styal_rt_session_secret",
    thumbprint: "key-thumbprint",
    ...overrides,
  });
}

const exchangeClerkSession = vi.fn();
const verify = vi.fn();
const relaySignOut = vi.fn();
const relayDeleteAccount = vi.fn();
const clerkSignOut = vi.fn(() => {
  calls.push("clerk-sign-out");
  return Promise.resolve();
});

const provideFakes = <A, E>(effect: Effect.Effect<A, E, unknown>) =>
  (
    effect as Effect.Effect<
      A,
      E,
      ManagedRelay.ManagedRelayClient | ManagedRelay.ManagedRelayDpopSigner
    >
  ).pipe(
    Effect.provideService(ManagedRelay.ManagedRelayClient, fakes.client as never),
    Effect.provideService(ManagedRelay.ManagedRelayDpopSigner, fakes.signer as never),
  );

const startSessionRuntime = Effect.gen(function* () {
  const requests = yield* Queue.unbounded<RuntimeRequest>();
  runtimeRequests.enqueue = (request) => {
    Queue.offerUnsafe(requests, request);
  };
  for (const request of runtimeRequests.pending.splice(0)) runtimeRequests.enqueue(request);
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        const request = yield* Queue.take(requests);
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            request.resolve(yield* Effect.exit(provideFakes(request.operation)));
          }),
        );
      }),
    ),
  );
});

const settle = <A>(promise: Promise<A>) =>
  Effect.gen(function* () {
    yield* startSessionRuntime;
    return yield* Effect.promise(() => promise);
  });

beforeEach(() => {
  vi.clearAllMocks();
  runtimeRequests.pending.length = 0;
  runtimeRequests.enqueue = null;
  secureStore.clear();
  // The keychain accessibility update has already run on this device.
  secureStore.set("styal.cloud.keychain-accessibility", "2");
  calls.length = 0;
  config.extra = { relay: { url: RELAY_URL } };
  appAtomRegistry.set(relaySignInAtom, { status: "loading" });
  appAtomRegistry.set(managedRelayAuthLoadAtom, "loading");
  exchangeClerkSession.mockReset().mockReturnValue(Effect.succeed(signIn));
  verify.mockReset().mockReturnValue(Effect.succeed(signIn));
  relaySignOut.mockReset().mockImplementation(() =>
    Effect.sync(() => {
      calls.push("relay-sign-out");
    }),
  );
  relayDeleteAccount.mockReset().mockImplementation(() =>
    Effect.sync(() => {
      calls.push("relay-delete-account");
    }),
  );
  clerkSignOut.mockClear();
  vi.mocked(unregisterAgentAwarenessDeviceForCurrentUser)
    .mockReset()
    .mockImplementation(() =>
      Effect.sync(() => {
        calls.push("unregister-device");
      }),
    );
  fakes.client = {
    exchangeClerkSession,
    verifyEmailSignIn: verify,
    signOut: relaySignOut,
    deleteAccount: relayDeleteAccount,
  };
  fakes.signer = { thumbprint: Effect.succeed("key-thumbprint") };
  setLegacyClerkSignOut(clerkSignOut);
});

describe("restoring the saved sign-in", () => {
  it.effect("publishes a sign-in saved for this relay and key", () =>
    Effect.gen(function* () {
      secureStore.set(SESSION_KEY, storedRecord());
      yield* settle(restoreRelaySession());
      expect(appAtomRegistry.get(relaySignInAtom)).toEqual({
        status: "ready",
        session: {
          accountId: "account-1",
          email: "someone@example.com",
          credential: signIn.credential,
        },
      });
    }),
  );

  it.effect.each([
    { label: "another relay", overrides: { relayUrl: "https://other-relay.example.test" } },
    { label: "another DPoP key", overrides: { thumbprint: "replaced-key" } },
  ])("discards a sign-in saved for $label", ({ overrides }) =>
    Effect.gen(function* () {
      secureStore.set(SESSION_KEY, storedRecord(overrides));
      yield* settle(restoreRelaySession());
      expect(secureStore.has(SESSION_KEY)).toBe(false);
      expect(appAtomRegistry.get(relaySignInAtom)).toEqual({ status: "ready", session: null });
    }),
  );

  it.effect("reports a failure when the DPoP key cannot be read", () =>
    Effect.gen(function* () {
      secureStore.set(SESSION_KEY, storedRecord());
      fakes.signer = {
        thumbprint: Effect.fail(
          new ManagedRelay.ManagedRelayDpopKeyLoadError({
            keyStore: "expo-secure-store",
            cause: "locked",
          }),
        ),
      };
      yield* settle(restoreRelaySession());
      expect(appAtomRegistry.get(relaySignInAtom)).toEqual({ status: "failed" });
      expect(appAtomRegistry.get(managedRelayAuthLoadAtom)).toBe("failed");
      // The record stays for the retry on the next foreground.
      expect(secureStore.has(SESSION_KEY)).toBe(true);
    }),
  );
});

describe("moving a Clerk sign-in", () => {
  beforeEach(() => {
    config.extra = {
      relay: { url: RELAY_URL },
      clerk: { publishableKey: "pk_test_example", jwtTemplate: "t3-relay" },
    };
  });

  it.effect("waits for Clerk when nothing is saved, then saves the moved sign-in", () =>
    Effect.gen(function* () {
      yield* settle(restoreRelaySession());
      expect(appAtomRegistry.get(relaySignInAtom)).toEqual({ status: "adopting" });

      yield* settle(adoptClerkSession(() => Promise.resolve("clerk-session-token")));

      expect(exchangeClerkSession).toHaveBeenCalledWith({
        clerkToken: "clerk-session-token",
        label: "Test iPhone",
      });
      expect(JSON.parse(secureStore.get(SESSION_KEY) ?? "null")).toEqual(
        JSON.parse(storedRecord()),
      );
      expect(appAtomRegistry.get(relaySignInAtom)).toMatchObject({
        status: "ready",
        session: { accountId: "account-1" },
      });
      expect(clerkSignOut).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("settles as signed out when Clerk reports no sign-in as soon as adoption starts", () =>
    Effect.gen(function* () {
      // The adoption component can react to "adopting" before the restore
      // that published it has finished.
      const settled = yield* Deferred.make<Promise<void>>();
      const unsubscribe = appAtomRegistry.subscribe(relaySignInAtom, (state) => {
        if (state.status === "adopting") {
          Deferred.doneUnsafe(settled, Effect.succeed(finishClerkAdoptionSignedOut()));
        }
      });
      yield* Effect.gen(function* () {
        yield* settle(restoreRelaySession());
        yield* settle(yield* Deferred.await(settled));
      }).pipe(Effect.ensuring(Effect.sync(unsubscribe)));
      expect(appAtomRegistry.get(relaySignInAtom)).toEqual({ status: "ready", session: null });
    }),
  );

  it.effect("never moves a Clerk sign-in over once this install has had a relay session", () =>
    Effect.gen(function* () {
      secureStore.set("styal.cloud.clerk-retired", "1");
      yield* settle(restoreRelaySession());
      expect(appAtomRegistry.get(relaySignInAtom)).toEqual({ status: "ready", session: null });
      expect(exchangeClerkSession).not.toHaveBeenCalled();
    }),
  );

  it.effect("keeps Clerk and retries later when the relay cannot be reached", () =>
    Effect.gen(function* () {
      yield* settle(restoreRelaySession());
      exchangeClerkSession.mockReturnValue(
        Effect.fail(
          new ManagedRelay.ManagedRelayRequestFailedError({
            action: "move styal Link sign-in from Clerk",
            transportFailed: true,
            cause: "offline",
          }),
        ),
      );

      yield* settle(adoptClerkSession(() => Promise.resolve("clerk-session-token")));

      expect(appAtomRegistry.get(relaySignInAtom)).toEqual({ status: "failed" });
      expect(appAtomRegistry.get(managedRelayAuthLoadAtom)).toBe("failed");
      expect(clerkSignOut).not.toHaveBeenCalled();

      yield* settle(restoreRelaySession());
      expect(appAtomRegistry.get(relaySignInAtom)).toEqual({ status: "adopting" });
    }),
  );

  it.effect("signs out of Clerk when the relay rejects the Clerk session", () =>
    Effect.gen(function* () {
      yield* settle(restoreRelaySession());
      exchangeClerkSession.mockReturnValue(
        Effect.fail(
          new ManagedRelay.ManagedRelayRequestFailedError({
            action: "move styal Link sign-in from Clerk",
            cause: "rejected",
            relayError: new RelayAuthInvalidError({
              code: "auth_invalid",
              reason: "invalid_bearer",
              traceId: "trace",
            }),
          }),
        ),
      );

      yield* settle(adoptClerkSession(() => Promise.resolve("clerk-session-token")));

      expect(clerkSignOut).toHaveBeenCalledTimes(1);
      expect(appAtomRegistry.get(relaySignInAtom)).toEqual({ status: "ready", session: null });
    }),
  );
});

describe("email sign-in and sign-out", () => {
  it.effect("saves and publishes a verified email sign-in", () =>
    Effect.gen(function* () {
      yield* provideFakes(verifyEmailSignIn({ email: "someone@example.com", code: "12345678" }));
      expect(verify).toHaveBeenCalledWith({
        email: "someone@example.com",
        code: "12345678",
        label: "Test iPhone",
      });
      expect(secureStore.get(SESSION_KEY)).toBeDefined();
      expect(appAtomRegistry.get(relaySignInAtom)).toMatchObject({
        status: "ready",
        session: { email: "someone@example.com" },
      });
    }),
  );

  it.effect(
    "removes the device registration before ending the session, then forgets the sign-in",
    () =>
      Effect.gen(function* () {
        secureStore.set(SESSION_KEY, storedRecord());
        yield* settle(restoreRelaySession());

        yield* provideFakes(signOutOfRelay);

        expect(unregisterAgentAwarenessDeviceForCurrentUser).toHaveBeenCalledWith(
          signIn.credential,
        );
        expect(calls).toEqual([
          "stop-registration",
          "unregister-device",
          "relay-sign-out",
          `delete:${SESSION_KEY}`,
          "clerk-sign-out",
        ]);
        expect(appAtomRegistry.get(relaySignInAtom)).toEqual({ status: "ready", session: null });
      }),
  );

  it.effect("forgets the sign-in on this device when the relay cannot be reached", () =>
    Effect.gen(function* () {
      secureStore.set(SESSION_KEY, storedRecord());
      yield* settle(restoreRelaySession());
      relaySignOut.mockReturnValue(
        Effect.fail(
          new ManagedRelay.ManagedRelayRequestFailedError({
            action: "sign out of styal Link",
            transportFailed: true,
            cause: "offline",
          }),
        ),
      );

      yield* provideFakes(signOutOfRelay);

      expect(secureStore.has(SESSION_KEY)).toBe(false);
      expect(appAtomRegistry.get(relaySignInAtom)).toEqual({ status: "ready", session: null });
    }),
  );
});

const nextSignIn = {
  credential: { accountId: "account-2", refreshToken: "styal_rt_newer_secret" },
  email: "new-account@example.test",
};
const emailInput = { email: nextSignIn.email, code: "12345678" };

function expectNextSignIn() {
  expect(appAtomRegistry.get(relaySignInAtom)).toMatchObject({
    status: "ready",
    session: { accountId: nextSignIn.credential.accountId },
  });
  expect(JSON.parse(secureStore.get(SESSION_KEY) ?? "null")).toMatchObject({
    accountId: nextSignIn.credential.accountId,
    refreshToken: nextSignIn.credential.refreshToken,
  });
}

describe("retrying Clerk adoption", () => {
  beforeEach(() => {
    appAtomRegistry.set(relaySignInAtom, { status: "adopting" });
  });

  it.effect("keeps Clerk when saving the exchanged session fails, then retries", () =>
    Effect.gen(function* () {
      yield* startSessionRuntime;
      vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("keychain unavailable"));
      yield* Effect.promise(() => adoptClerkSession(() => Promise.resolve("clerk-token")));
      expect(appAtomRegistry.get(relaySignInAtom)).toEqual({ status: "failed" });
      expect(clerkSignOut).not.toHaveBeenCalled();
      expect(secureStore.has(SESSION_KEY)).toBe(false);

      appAtomRegistry.set(relaySignInAtom, { status: "adopting" });
      yield* Effect.promise(() => adoptClerkSession(() => Promise.resolve("clerk-token")));
      expect(appAtomRegistry.get(relaySignInAtom)).toMatchObject({
        status: "ready",
        session: { accountId: signIn.credential.accountId },
      });
      expect(clerkSignOut).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("keeps Clerk when the exchanged session's DPoP thumbprint cannot be loaded", () =>
    Effect.gen(function* () {
      yield* startSessionRuntime;
      fakes.signer = {
        thumbprint: Effect.fail(
          new ManagedRelay.ManagedRelayDpopKeyLoadError({
            keyStore: "expo-secure-store",
            cause: "locked",
          }),
        ),
      };
      yield* Effect.promise(() => adoptClerkSession(() => Promise.resolve("clerk-token")));
      expect(appAtomRegistry.get(relaySignInAtom)).toEqual({ status: "failed" });
      expect(clerkSignOut).not.toHaveBeenCalled();
      expect(secureStore.has(SESSION_KEY)).toBe(false);
    }),
  );

  it.effect.each([
    new ManagedRelay.ManagedRelayDpopKeyLoadError({
      keyStore: "expo-secure-store",
      cause: "locked",
    }),
    new ManagedRelay.ManagedRelayDpopProofCreationError({
      method: "POST",
      url: RELAY_URL,
      cause: "unavailable",
    }),
    new ManagedRelay.ManagedRelayRequestFailedError({
      action: "move styal Link sign-in from Clerk",
      cause: "invalid proof",
      relayError: new RelayAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_dpop",
        traceId: "trace",
      }),
    }),
  ])("retains Clerk on a retryable $_tag exchange failure", (error) =>
    Effect.gen(function* () {
      yield* startSessionRuntime;
      exchangeClerkSession.mockReturnValue(Effect.fail(error));
      yield* Effect.promise(() => adoptClerkSession(() => Promise.resolve("clerk-token")));
      expect(appAtomRegistry.get(relaySignInAtom)).toEqual({ status: "failed" });
      expect(appAtomRegistry.get(managedRelayAuthLoadAtom)).toBe("failed");
      expect(clerkSignOut).not.toHaveBeenCalled();
    }),
  );

  it.effect.each([null, undefined])(
    "does not infer sign-out from an unavailable Clerk token (%s)",
    (token) =>
      Effect.gen(function* () {
        yield* startSessionRuntime;
        yield* Effect.promise(() =>
          adoptClerkSession(() =>
            token === undefined
              ? Promise.reject(new Error("Clerk unavailable"))
              : Promise.resolve(token),
          ),
        );
        expect(appAtomRegistry.get(relaySignInAtom)).toEqual({ status: "failed" });
        expect(clerkSignOut).not.toHaveBeenCalled();
        expect(exchangeClerkSession).not.toHaveBeenCalled();
      }),
  );
});

describe("superseded session operations", () => {
  it.effect.each(["clerk-token", null])(
    "discards a stale Clerk token read (%s) after email sign-in",
    (token) =>
      Effect.gen(function* () {
        yield* startSessionRuntime;
        appAtomRegistry.set(relaySignInAtom, { status: "adopting" });
        const clerkToken = Promise.withResolvers<string | null>();
        const adoption = adoptClerkSession(() => clerkToken.promise);
        failClerkAdoption();
        verify.mockReturnValue(Effect.succeed(nextSignIn));
        yield* provideFakes(verifyEmailSignIn(emailInput));
        clerkToken.resolve(token);
        yield* Effect.promise(() => adoption);
        expectNextSignIn();
        expect(exchangeClerkSession).not.toHaveBeenCalled();
      }),
  );

  it.effect("discards an exchanged Clerk session superseded by email sign-in", () =>
    Effect.gen(function* () {
      yield* startSessionRuntime;
      appAtomRegistry.set(relaySignInAtom, { status: "adopting" });
      const started = Promise.withResolvers<void>();
      const exchange = Promise.withResolvers<typeof signIn>();
      exchangeClerkSession.mockImplementation(() =>
        Effect.promise(() => {
          started.resolve();
          return exchange.promise;
        }),
      );
      const adoption = adoptClerkSession(() => Promise.resolve("clerk-token"));
      yield* Effect.promise(() => started.promise);
      verify.mockReturnValue(Effect.succeed(nextSignIn));
      yield* provideFakes(verifyEmailSignIn(emailInput));
      exchange.resolve(signIn);
      yield* Effect.promise(() => adoption);
      expectNextSignIn();
      expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(2);
      expect(relaySignOut).toHaveBeenCalledWith({ credential: signIn.credential });
      expect(clerkSignOut).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect(
    "does not start a foreground adoption while explicit email verification is pending",
    () =>
      Effect.gen(function* () {
        yield* startSessionRuntime;
        config.extra = { relay: { url: RELAY_URL }, clerk: { publishableKey: "pk_test_example" } };
        appAtomRegistry.set(relaySignInAtom, { status: "failed" });
        const started = Promise.withResolvers<void>();
        const verification = Promise.withResolvers<typeof nextSignIn>();
        verify.mockImplementation(() =>
          Effect.promise(() => {
            started.resolve();
            return verification.promise;
          }),
        );
        const signingIn = yield* Effect.forkChild(provideFakes(verifyEmailSignIn(emailInput)));
        yield* Effect.promise(() => started.promise);
        yield* Effect.promise(() => restoreRelaySession());
        expect(appAtomRegistry.get(relaySignInAtom)).toEqual({ status: "failed" });
        verification.resolve(nextSignIn);
        yield* Fiber.join(signingIn);
        expectNextSignIn();
      }),
  );

  it.effect("ignores Clerk recovery callbacks while a newer email verification is pending", () =>
    Effect.gen(function* () {
      yield* startSessionRuntime;
      appAtomRegistry.set(relaySignInAtom, { status: "adopting" });
      const clerkToken = Promise.withResolvers<string | null>();
      const adoption = adoptClerkSession(() => clerkToken.promise);
      const started = Promise.withResolvers<void>();
      const verification = Promise.withResolvers<typeof nextSignIn>();
      verify.mockImplementation(() =>
        Effect.promise(() => {
          started.resolve();
          return verification.promise;
        }),
      );
      const signingIn = yield* Effect.forkChild(provideFakes(verifyEmailSignIn(emailInput)));
      yield* Effect.promise(() => started.promise);
      failClerkAdoption();
      finishClerkAdoptionSignedOut();
      verification.resolve(nextSignIn);
      yield* Fiber.join(signingIn);
      clerkToken.resolve(null);
      yield* Effect.promise(() => adoption);
      expectNextSignIn();
    }),
  );

  it.effect("rechecks adoption after loading the thumbprint before saving", () =>
    Effect.gen(function* () {
      yield* startSessionRuntime;
      appAtomRegistry.set(relaySignInAtom, { status: "adopting" });
      const started = Promise.withResolvers<void>();
      const thumbprint = Promise.withResolvers<string>();
      fakes.signer = {
        thumbprint: Effect.promise(() => {
          started.resolve();
          return thumbprint.promise;
        }),
      };
      const adoption = adoptClerkSession(() => Promise.resolve("clerk-token"));
      yield* Effect.promise(() => started.promise);
      const verifying = Promise.withResolvers<void>();
      verify.mockImplementation(() =>
        Effect.sync(() => {
          verifying.resolve();
          return nextSignIn;
        }),
      );
      const signingIn = yield* Effect.forkChild(provideFakes(verifyEmailSignIn(emailInput)));
      yield* Effect.promise(() => verifying.promise);
      fakes.signer = { thumbprint: Effect.succeed("key-thumbprint") };
      thumbprint.resolve("key-thumbprint");
      yield* Effect.promise(() => adoption);
      yield* Fiber.join(signingIn);
      expectNextSignIn();
      expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(2);
      expect(relaySignOut).toHaveBeenCalledWith({ credential: signIn.credential });
    }),
  );

  it.effect(
    "serializes sign-in behind a session-ended delete and ignores duplicate callbacks",
    () =>
      Effect.gen(function* () {
        yield* startSessionRuntime;
        secureStore.set(SESSION_KEY, storedRecord());
        yield* Effect.promise(() => restoreRelaySession());
        const deletionStarted = Promise.withResolvers<void>();
        const finishDelete = Promise.withResolvers<void>();
        vi.mocked(SecureStore.deleteItemAsync).mockImplementationOnce(async (key) => {
          deletionStarted.resolve();
          await finishDelete.promise;
          secureStore.delete(key);
        });
        const ending = yield* Effect.forkChild(provideFakes(endRelaySession(signIn.credential)));
        yield* Effect.promise(() => deletionStarted.promise);
        const duplicateEnding = yield* Effect.forkChild(
          provideFakes(endRelaySession(signIn.credential)),
        );
        const verifying = Promise.withResolvers<void>();
        verify.mockImplementation(() =>
          Effect.sync(() => {
            verifying.resolve();
            return nextSignIn;
          }),
        );
        const signingIn = yield* Effect.forkChild(provideFakes(verifyEmailSignIn(emailInput)));
        yield* Effect.promise(() => verifying.promise);
        expect(JSON.parse(secureStore.get(SESSION_KEY)!)).toMatchObject({ accountId: "account-1" });
        finishDelete.resolve();
        yield* Fiber.join(ending);
        yield* Fiber.join(duplicateEnding);
        yield* Fiber.join(signingIn);
        expectNextSignIn();
        expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect.each(["sign-out", "account deletion"])(
    "does not clear a newer email sign-in during %s",
    (action) =>
      Effect.gen(function* () {
        yield* startSessionRuntime;
        secureStore.set(SESSION_KEY, storedRecord());
        yield* Effect.promise(() => restoreRelaySession());
        const started = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        (action === "sign-out" ? relaySignOut : relayDeleteAccount).mockImplementation(() =>
          Effect.promise(() => {
            started.resolve();
            return finish.promise;
          }),
        );
        const ending = yield* Effect.forkChild(
          provideFakes(action === "sign-out" ? signOutOfRelay : deleteRelayAccount),
        );
        yield* Effect.promise(() => started.promise);
        const verifying = Promise.withResolvers<void>();
        verify.mockImplementation(() =>
          Effect.sync(() => {
            verifying.resolve();
            return nextSignIn;
          }),
        );
        const signingIn = yield* Effect.forkChild(provideFakes(verifyEmailSignIn(emailInput)));
        yield* Effect.promise(() => verifying.promise);
        finish.resolve();
        yield* Fiber.join(ending);
        yield* Fiber.join(signingIn);
        expectNextSignIn();
        expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
      }),
  );

  it.effect.each(["sign-out", "account deletion"])(
    "discards pending email verification after %s begins",
    (action) =>
      Effect.gen(function* () {
        yield* startSessionRuntime;
        secureStore.set(SESSION_KEY, storedRecord());
        yield* Effect.promise(() => restoreRelaySession());
        const started = Promise.withResolvers<void>();
        const verification = Promise.withResolvers<typeof nextSignIn>();
        verify.mockImplementation(() =>
          Effect.promise(() => {
            started.resolve();
            return verification.promise;
          }),
        );
        const signingIn = yield* Effect.forkChild(provideFakes(verifyEmailSignIn(emailInput)));
        yield* Effect.promise(() => started.promise);
        yield* provideFakes(action === "sign-out" ? signOutOfRelay : deleteRelayAccount);
        verification.resolve(nextSignIn);
        yield* Fiber.join(signingIn);
        expect(appAtomRegistry.get(relaySignInAtom)).toEqual({ status: "ready", session: null });
        expect(secureStore.has(SESSION_KEY)).toBe(false);
        expect(relaySignOut).toHaveBeenCalledWith({ credential: nextSignIn.credential });
      }),
  );

  it.effect(
    "unregisters before deleting the account and resumes registration if deletion fails",
    () =>
      Effect.gen(function* () {
        yield* startSessionRuntime;
        secureStore.set(SESSION_KEY, storedRecord());
        yield* Effect.promise(() => restoreRelaySession());
        relayDeleteAccount.mockReturnValueOnce(Effect.fail(new Error("offline")));
        const failure = yield* Effect.flip(provideFakes(deleteRelayAccount));
        expect(failure).toEqual(new Error("offline"));
        expect(calls).toEqual(["stop-registration", "unregister-device"]);
        expect(setAgentAwarenessRelayCredential).toHaveBeenCalledWith(signIn.credential);
        expect(secureStore.has(SESSION_KEY)).toBe(true);
        expect(appAtomRegistry.get(relaySignInAtom)).toMatchObject({
          status: "ready",
          session: { accountId: "account-1" },
        });

        calls.length = 0;
        yield* provideFakes(deleteRelayAccount);
        expect(calls).toEqual([
          "stop-registration",
          "unregister-device",
          "relay-delete-account",
          `delete:${SESSION_KEY}`,
          "clerk-sign-out",
        ]);
        expect(appAtomRegistry.get(relaySignInAtom)).toEqual({ status: "ready", session: null });
      }),
  );
});

/** Uses the real client's token cache and session-ended callback with a fake relay transport. */
function sessionClientLayer(
  fetchFn: typeof globalThis.fetch,
  options: Pick<
    ManagedRelay.ManagedRelayClientLayerOptions,
    "accessTokenStore" | "onSessionEnded"
  > = {},
) {
  return ManagedRelay.layer({
    relayUrl: RELAY_URL,
    clientId: "t3-mobile",
    onSessionEnded: endRelaySession,
    ...options,
  }).pipe(
    Layer.provide(
      Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, {
        thumbprint: Effect.succeed("key-thumbprint"),
        createProof: () => Effect.succeed("synthetic-dpop-proof"),
      }),
    ),
    Layer.provide(layerRemoteHttpClient(fetchFn)),
  );
}

describe("session-ended callbacks during teardown", () => {
  it.effect.each(["sign-out", "account deletion"])(
    "finishes %s when a relay request awaits the real session mutation lock",
    (action) => {
      const requests: string[] = [];
      const ended: ManagedRelay.ManagedRelayCredential[] = [];
      const fetchFn = ((input) => {
        const url = String(input);
        requests.push(url);
        return Promise.resolve(
          url.endsWith("/v1/auth/sign-out")
            ? Response.json({ ok: true })
            : Response.json(
                {
                  _tag: "RelayAuthInvalidError",
                  code: "auth_invalid",
                  reason: "invalid_session",
                  traceId: "trace-ended-session",
                },
                { status: 401 },
              ),
        );
      }) satisfies typeof globalThis.fetch;

      return Effect.gen(function* () {
        secureStore.set(SESSION_KEY, storedRecord());
        yield* settle(restoreRelaySession());
        if (action === "sign-out") {
          // Keep the registration adapter's best-effort behavior, using the real client.
          vi.mocked(unregisterAgentAwarenessDeviceForCurrentUser).mockImplementation((credential) =>
            ManagedRelay.ManagedRelayClient.pipe(
              Effect.flatMap((client) =>
                client.unregisterDevice({ credential, deviceId: "test-phone" }),
              ),
              Effect.ignore,
            ),
          );
        }

        const result = yield* Effect.exit(
          action === "sign-out" ? signOutOfRelay : deleteRelayAccount,
        );

        expect(result._tag).toBe(action === "sign-out" ? "Success" : "Failure");
        expect(ended).toEqual([signIn.credential]);
        expect(requests).toContain(`${RELAY_URL}/v1/auth/token`);
        expect(secureStore.has(SESSION_KEY)).toBe(false);
        expect(appAtomRegistry.get(relaySignInAtom)).toEqual({ status: "ready", session: null });
        expect(setAgentAwarenessRelayCredential).not.toHaveBeenCalled();

        // A later sign-in still acquires the same real semaphore and persists normally.
        yield* provideFakes(verifyEmailSignIn(emailInput));
        expect(secureStore.has(SESSION_KEY)).toBe(true);
      }).pipe(
        Effect.provide(
          sessionClientLayer(fetchFn, {
            onSessionEnded: (credential) =>
              Effect.sync(() => ended.push(credential)).pipe(
                Effect.andThen(endRelaySession(credential)),
              ),
          }),
        ),
      );
    },
  );
});

describe("discarding a superseded sign-in", () => {
  it.effect.each(["email verification", "Clerk exchange"])(
    "forgets the access token created by a late %s even when remote sign-out fails",
    (action) => {
      const started = Promise.withResolvers<void>();
      const response = Promise.withResolvers<Response>();
      const revoked: string[] = [];
      let tokens: ReadonlyArray<ManagedRelay.ManagedRelayAccessTokenCacheEntry> = [];
      const cached: string[] = [];
      const fetchFn = ((input, init) => {
        if (String(input).endsWith("/v1/auth/sign-out")) {
          revoked.push(JSON.parse(String(init?.body)).refresh_token);
          return Promise.reject(new Error("offline"));
        }
        started.resolve();
        return response.promise;
      }) satisfies typeof globalThis.fetch;

      return Effect.gen(function* () {
        yield* startSessionRuntime;
        fakes.client = yield* ManagedRelay.ManagedRelayClient;
        appAtomRegistry.set(relaySignInAtom, { status: "adopting" });
        const signingIn = yield* Effect.forkChild(
          action === "email verification"
            ? provideFakes(verifyEmailSignIn(emailInput))
            : Effect.promise(() => adoptClerkSession(() => Promise.resolve("clerk-token"))),
        );
        yield* Effect.promise(() => started.promise);
        yield* provideFakes(signOutOfRelay);
        response.resolve(
          Response.json({
            access_token: "synthetic-access-token",
            refresh_token: signIn.credential.refreshToken,
            session_id: "synthetic-session-id",
            token_type: "DPoP",
            expires_in: 1800,
            scope: "account",
            user: { id: signIn.credential.accountId, email: signIn.email },
          }),
        );
        yield* Fiber.join(signingIn);

        expect(cached).toContain("synthetic-access-token");
        expect(tokens).toEqual([]);
        expect(revoked).toEqual([signIn.credential.refreshToken]);
        expect(secureStore.has(SESSION_KEY)).toBe(false);
        expect(appAtomRegistry.get(relaySignInAtom)).toEqual({ status: "ready", session: null });
      }).pipe(
        Effect.provide(
          sessionClientLayer(fetchFn, {
            accessTokenStore: {
              load: Effect.succeed([]),
              save: (entries) =>
                Effect.sync(() => {
                  tokens = entries;
                  cached.push(...entries.map((entry) => entry.accessToken));
                }),
              clear: Effect.sync(() => {
                tokens = [];
              }),
            },
          }),
        ),
      );
    },
  );
});
