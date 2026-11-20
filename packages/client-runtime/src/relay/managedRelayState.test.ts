import { EnvironmentId } from "@t3tools/contracts";
import {
  type RelayClientDeviceRecord,
  type RelayClientEnvironmentRecord,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, vi } from "vite-plus/test";

import * as ManagedRelay from "./managedRelay.ts";
import {
  createManagedRelayQueryManager,
  deregisterManagedRelayEnvironment,
  ManagedRelaySessionError,
  managedRelaySessionAtom,
  setManagedRelaySession,
} from "./managedRelayState.ts";

let registry = AtomRegistry.make();

const environment = {
  environmentId: EnvironmentId.make("environment-1"),
  label: "Main environment",
  endpoint: {
    httpBaseUrl: "https://environment.example.test",
    wsBaseUrl: "wss://environment.example.test",
    providerKind: "cloudflare_tunnel",
  },
  linkedAt: "2026-06-01T00:00:00.000Z",
} satisfies RelayClientEnvironmentRecord;

const device = {
  deviceId: "device-1",
  label: "Julius iPhone",
  platform: "ios",
  iosMajorVersion: 18,
  appVersion: null,
  notifications: {
    enabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
  liveActivities: {
    enabled: true,
  },
  updatedAt: "2026-06-01T00:00:00.000Z",
} satisfies RelayClientDeviceRecord;

function resetRegistry() {
  registry.dispose();
  registry = AtomRegistry.make();
}

function createClient(overrides?: Partial<ManagedRelay.ManagedRelayClient["Service"]>) {
  return ManagedRelay.ManagedRelayClient.of({
    relayUrl: "https://relay.example.test",
    startEmailSignIn: () => Effect.die("unused"),
    verifyEmailSignIn: () => Effect.die("unused"),
    exchangeClerkSession: () => Effect.die("unused"),
    signOut: () => Effect.die("unused"),
    getAccount: () => Effect.die("unused"),
    listSessions: () => Effect.die("unused"),
    revokeSession: () => Effect.die("unused"),
    deleteAccount: () => Effect.die("unused"),
    listEnvironments: () => Effect.succeed([environment]),
    listDevices: () => Effect.succeed([device]),
    createEnvironmentLinkChallenge: () => Effect.die("unused"),
    linkEnvironment: () => Effect.die("unused"),
    unlinkEnvironment: () => Effect.die("unused"),
    getT3ChatLink: () => Effect.die("unused"),
    createT3ChatLinkRequest: () => Effect.die("unused"),
    unlinkT3Chat: () => Effect.die("unused"),
    getEnvironmentStatus: () =>
      Effect.succeed({
        environmentId: environment.environmentId,
        endpoint: environment.endpoint,
        status: "online",
        checkedAt: "2026-06-01T00:00:00.000Z",
      }),
    connectEnvironment: () => Effect.die("unused"),
    registerDevice: () => Effect.die("unused"),
    unregisterDevice: () => Effect.die("unused"),
    registerLiveActivity: () => Effect.die("unused"),
    getAgentActivitySnapshot: () => Effect.die("unused"),
    resetTokenCache: Effect.void,
    ...overrides,
  });
}

function session(accountId: string, refreshToken = `styal_rt_${accountId}`) {
  return {
    accountId,
    email: `${accountId}@example.com`,
    credential: { accountId, refreshToken },
  };
}

function setSession() {
  setManagedRelaySession(registry, session("account-1"));
}

describe("createManagedRelayQueryManager", () => {
  afterEach(resetRegistry);

  it.effect("logs a failed device listing once however many readers mount it", () =>
    Effect.gen(function* () {
      const logs: Array<unknown> = [];
      const runtime = Atom.runtime(
        Layer.mergeAll(
          Layer.succeed(
            ManagedRelay.ManagedRelayClient,
            createClient({
              listDevices: () =>
                Effect.fail(
                  new ManagedRelay.ManagedRelayRequestFailedError({
                    action: "list relay client devices",
                    cause: new Error("relay down"),
                  }),
                ),
            }),
          ),
          Logger.layer([Logger.make(({ message }) => logs.push(message))], {
            mergeWithExisting: false,
          }),
        ),
      );
      const manager = createManagedRelayQueryManager(runtime);
      setSession();
      const atom = manager.devicesAtom("account-1");

      const failed = Promise.withResolvers<void>();
      const readers = [0, 1].map(() =>
        registry.subscribe(
          atom,
          (result) => {
            if (result._tag === "Failure") failed.resolve();
          },
          { immediate: true },
        ),
      );
      yield* Effect.promise(() => failed.promise);
      for (const unsubscribe of readers) unsubscribe();

      expect(logs).toEqual([["[t3-cloud] Relay device listing failed"]]);
    }),
  );

  it.effect("rejects deregistration after the account changes", () =>
    Effect.gen(function* () {
      const unlinkEnvironment = vi.fn(() => Effect.succeed({ ok: true }));
      setSession();

      const error = yield* deregisterManagedRelayEnvironment(registry, {
        accountId: "previous-account",
        environmentId: environment.environmentId,
      }).pipe(
        Effect.provideService(ManagedRelay.ManagedRelayClient, createClient({ unlinkEnvironment })),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(ManagedRelaySessionError);
      expect(unlinkEnvironment).not.toHaveBeenCalled();
    }),
  );

  it("keeps the session object when the same sign-in is published again", () => {
    {
      setManagedRelaySession(registry, session("account-1"));
      const first = registry.get(managedRelaySessionAtom);
      setManagedRelaySession(registry, session("account-1"));
      expect(registry.get(managedRelaySessionAtom)).toBe(first);

      setManagedRelaySession(registry, session("account-1", "styal_rt_new_session"));
      expect(registry.get(managedRelaySessionAtom)).not.toBe(first);
      expect(registry.get(managedRelaySessionAtom)?.credential.refreshToken).toBe(
        "styal_rt_new_session",
      );
    }
  });
});
