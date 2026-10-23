import { EnvironmentId } from "@t3tools/contracts";
import {
  RelayAuthInvalidError,
  type RelayClientDeviceRecord,
  type RelayClientEnvironmentRecord,
  type RelayEnvironmentStatusResponse,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, vi } from "vite-plus/test";

import { DPOP_UNKNOWN_HINT } from "./errorPresentation.ts";
import * as ManagedRelay from "./managedRelay.ts";
import {
  createManagedRelayQueryManager,
  deregisterManagedRelayEnvironment,
  managedRelayAccountChanges,
  type ManagedRelayQueryEvent,
  ManagedRelaySessionError,
  managedRelaySessionAtom,
  readManagedRelaySnapshotState,
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

function createManager(
  overrides?: Partial<ManagedRelay.ManagedRelayClient["Service"]>,
  onQueryEvent?: (event: ManagedRelayQueryEvent) => void,
) {
  const client = createClient(overrides);
  const runtime = Atom.runtime(Layer.succeed(ManagedRelay.ManagedRelayClient, client));
  return createManagedRelayQueryManager(runtime, {
    staleTimeMs: 60_000,
    ...(onQueryEvent ? { onQueryEvent } : {}),
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

  it.effect("deregisters an environment through the current session", () =>
    Effect.gen(function* () {
      const unlinkEnvironment = vi.fn(() => Effect.succeed({ ok: true }));
      setSession();

      yield* deregisterManagedRelayEnvironment(registry, {
        accountId: "account-1",
        environmentId: environment.environmentId,
      }).pipe(
        Effect.provideService(ManagedRelay.ManagedRelayClient, createClient({ unlinkEnvironment })),
      );

      expect(unlinkEnvironment).toHaveBeenCalledWith({
        credential: { accountId: "account-1", refreshToken: "styal_rt_account-1" },
        environmentId: environment.environmentId,
      });
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

  it.effect("emits credential changes only when the managed relay account changes", () =>
    Effect.gen(function* () {
      setManagedRelaySession(registry, session("account-1"));
      const changes = yield* managedRelayAccountChanges(registry).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(registry.getNodes().get(managedRelaySessionAtom)?.listeners.size).toBeGreaterThan(
            0,
          );
        }),
      );

      setManagedRelaySession(registry, session("account-1", "styal_rt_second_device"));
      setManagedRelaySession(registry, session("account-2"));
      setManagedRelaySession(registry, null);

      expect(Array.from(yield* Fiber.join(changes))).toEqual(["account-2", null]);
    }),
  );

  it("keeps environment snapshots cached and refreshes them explicitly", async () => {
    const listEnvironments = vi.fn(() => Effect.succeed([environment]));
    const manager = createManager({ listEnvironments });
    setSession();
    const atom = manager.environmentsAtom("account-1");

    registry.get(atom);
    await vi.waitFor(() => expect(listEnvironments).toHaveBeenCalledTimes(1));

    registry.get(manager.environmentsAtom("account-1"));
    expect(listEnvironments).toHaveBeenCalledTimes(1);

    manager.refreshEnvironments(registry, "account-1");
    await vi.waitFor(() => expect(listEnvironments).toHaveBeenCalledTimes(2));
  });

  it("loads device snapshots through the current account session", async () => {
    const listDevices = vi.fn(() => Effect.succeed([device]));
    const manager = createManager({ listDevices });
    setSession();
    const atom = manager.devicesAtom("account-1");

    registry.get(atom);
    await vi.waitFor(() => {
      expect(readManagedRelaySnapshotState(registry.get(atom)).data).toEqual([device]);
    });
  });

  it("reports token and relay request phases for environment status queries", async () => {
    const onQueryEvent = vi.fn();
    const manager = createManager(undefined, onQueryEvent);
    setSession();
    const atom = manager.environmentStatusAtom({ accountId: "account-1", environment });

    registry.get(atom);
    await vi.waitFor(() => {
      expect(readManagedRelaySnapshotState(registry.get(atom)).data?.status).toBe("online");
    });

    expect(onQueryEvent).toHaveBeenCalledWith({
      operation: "environment-status",
      stage: "session",
      phase: "start",
      accountId: "account-1",
      environmentId: environment.environmentId,
    });
    expect(onQueryEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "environment-status",
        stage: "relay-request",
        phase: "success",
        accountId: "account-1",
        environmentId: environment.environmentId,
      }),
    );
  });

  it("rejects status responses for a different environment", async () => {
    const mismatchedStatus = {
      environmentId: EnvironmentId.make("environment-2"),
      endpoint: environment.endpoint,
      status: "online",
      checkedAt: "2026-06-01T00:00:00.000Z",
    } satisfies RelayEnvironmentStatusResponse;
    const manager = createManager({
      getEnvironmentStatus: () => Effect.succeed(mismatchedStatus),
    });
    setSession();
    const atom = manager.environmentStatusAtom({ accountId: "account-1", environment });

    registry.get(atom);
    await vi.waitFor(() => {
      expect(readManagedRelaySnapshotState(registry.get(atom)).error).toBe(
        "Relay returned status for a different environment.",
      );
    });
  });

  it("exposes relay trace IDs alongside snapshot errors", async () => {
    const manager = createManager({
      getEnvironmentStatus: () =>
        Effect.fail(
          new ManagedRelay.ManagedRelayRequestFailedError({
            action: "get relay environment status",
            cause: new Error("Relay request failed."),
            traceId: "trace-status",
          }),
        ),
    });
    setSession();
    const atom = manager.environmentStatusAtom({ accountId: "account-1", environment });

    registry.get(atom);
    await vi.waitFor(() => {
      expect(readManagedRelaySnapshotState(registry.get(atom))).toMatchObject({
        error: "Could not get relay environment status.",
        errorTraceId: "trace-status",
      });
    });
  });

  it("presents clock skew as one possible cause for snapshot requests from older relays", async () => {
    const manager = createManager({
      getEnvironmentStatus: () =>
        Effect.fail(
          new ManagedRelay.ManagedRelayRequestFailedError({
            action: "get relay environment status",
            cause: new Error("Relay request failed."),
            relayError: new RelayAuthInvalidError({
              code: "auth_invalid",
              reason: "invalid_dpop",
              traceId: "trace-status",
            }),
            traceId: "trace-status",
          }),
        ),
    });
    setSession();
    const atom = manager.environmentStatusAtom({ accountId: "account-1", environment });

    registry.get(atom);
    await vi.waitFor(() => {
      expect(readManagedRelaySnapshotState(registry.get(atom)).error).toBe(
        `Relay rejected the DPoP proof. ${DPOP_UNKNOWN_HINT}`,
      );
    });
  });
});
