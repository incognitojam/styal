import { AuthStandardClientScopes, EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import type { RelayEnvironmentConnectResponse } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as TokenStore from "../authorization/tokenStore.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { fetchEnvironmentSessionState } from "../state/session.ts";
import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import { BearerConnectionProfile } from "./catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type ConnectionAttemptError,
  type ConnectionRouteFailure,
  type ConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as RpcSession from "../rpc/session.ts";
import { presentConnectionState } from "./presentation.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import { connectionRouteId, entryWithRoutes, isLearned, mergeLearnedRoutes } from "./routes.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const RELAY_TARGET = new RelayConnectionTarget({
  environmentId: TARGET.environmentId,
  label: TARGET.label,
});

const TARGET_ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  profile: Option.none(),
  enabled: true,
};

const RELAY_ENTRY: ConnectionCatalogEntry = {
  target: RELAY_TARGET,
  profile: Option.none(),
  enabled: true,
};

const PREPARED_CONNECTION: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: TARGET,
};

const TEST_RPC_CLIENT = {} as WsRpcProtocolClient;

const LAN_TARGET = new BearerConnectionTarget({
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  connectionId: "bearer:lan",
});
const LAN_ROUTE: ConnectionRoute = {
  target: LAN_TARGET,
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: LAN_TARGET.connectionId,
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      httpBaseUrl: "http://192.168.1.10:3773/",
      wsBaseUrl: "ws://192.168.1.10:3773/",
    }),
  ),
};
const LAN_THEN_RELAY_ENTRY: ConnectionCatalogEntry = {
  target: LAN_ROUTE.target,
  profile: LAN_ROUTE.profile,
  alternateRoutes: [{ target: RELAY_TARGET, profile: Option.none() }],
  enabled: true,
};

function preparedFor(target: ConnectionTarget): PreparedConnection {
  return { ...PREPARED_CONNECTION, target };
}

function transient(message = "Connection failed.") {
  return new ConnectionTransientError({
    reason: "transport",
    detail: message,
  });
}

function blocked(message = "Authentication required.") {
  return new ConnectionBlockedError({
    reason: "authentication",
    detail: message,
  });
}

function awaitState(
  state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
  predicate: (value: SupervisorConnectionState) => boolean,
) {
  return SubscriptionRef.changes(state).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}

const eventuallyState = Effect.fn("TestConnectionHarness.eventuallyState")(function* (
  state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
  predicate: (value: SupervisorConnectionState) => boolean,
) {
  let lastState = yield* SubscriptionRef.get(state);
  for (let iteration = 0; iteration < 100; iteration += 1) {
    lastState = yield* SubscriptionRef.get(state);
    if (predicate(lastState)) {
      return lastState;
    }
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(
    new Error(
      `Expected supervisor state was not observed. Last state: phase=${lastState.phase}, stage=${lastState.stage ?? "none"}, attempt=${lastState.attempt}, generation=${lastState.generation}`,
    ),
  );
});

const makeHarness = Effect.fn("TestConnectionHarness.make")(function* (options?: {
  readonly networkStatus?: NetworkStatus;
  readonly prepare?: (
    attempt: number,
    target: ConnectionTarget,
  ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
  readonly ready?: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
  readonly probe?: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
  readonly receivedFrames?: Effect.Effect<number>;
  readonly initialConfig?: (attempt: number) => Effect.Effect<ServerConfig, ConnectionAttemptError>;
  readonly checkRoute?: (route: ConnectionRoute) => Effect.Effect<ConnectionDriver.RouteCheck>;
}) {
  const networkStatus = yield* SubscriptionRef.make<NetworkStatus>(
    options?.networkStatus ?? "online",
  );
  const prepareCount = yield* Ref.make(0);
  const sessionCount = yield* Ref.make(0);
  const releaseCount = yield* Ref.make(0);
  const wakeups = yield* SubscriptionRef.make<{
    readonly sequence: number;
    readonly reason: ConnectionWakeups.ConnectionWakeup;
  }>({
    sequence: 0,
    reason: "application-active",
  });
  const closedSessions = yield* Ref.make<
    ReadonlyArray<Deferred.Deferred<never, ConnectionTransientError>>
  >([]);

  const connectivity = Connectivity.Connectivity.of({
    status: SubscriptionRef.get(networkStatus),
    changes: SubscriptionRef.changes(networkStatus),
  });

  const prepare = Effect.fn("TestConnectionDriver.prepare")(function* (target: ConnectionTarget) {
    const attempt = yield* Ref.updateAndGet(prepareCount, (count) => count + 1);
    if (options?.prepare) {
      return yield* options.prepare(attempt, target);
    }
    return PREPARED_CONNECTION;
  });

  const checkRoute = (route: ConnectionRoute) =>
    options?.checkRoute?.(route) ?? Effect.succeed<ConnectionDriver.RouteCheck>("unchecked");

  const connectRoute = Effect.fn("TestConnectionDriver.connectRoute")(function* (
    target: ConnectionTarget,
    reportProgress: (progress: ConnectionDriver.ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    const prepared = yield* prepare(target);
    yield* reportProgress({ stage: "opening", prepared });

    const attempt = yield* Ref.updateAndGet(sessionCount, (count) => count + 1);
    const closed = yield* Deferred.make<never, ConnectionTransientError>();
    yield* Ref.update(closedSessions, (sessions) => [...sessions, closed]);

    const session = yield* Effect.acquireRelease(
      Effect.succeed({
        client: TEST_RPC_CLIENT,
        initialConfig:
          options?.initialConfig?.(attempt) ??
          Effect.die(new Error("Initial config is not used by supervisor tests.")),
        subscribeServerConfig: (input) => TEST_RPC_CLIENT.subscribeServerConfig(input),
        ready: options?.ready?.(attempt) ?? Effect.void,
        probe: options?.probe?.(attempt) ?? Effect.void,
        receivedFrames: options?.receivedFrames ?? Effect.succeed(0),
        closed: Deferred.await(closed),
      } satisfies RpcSession.RpcSession),
      () => Ref.update(releaseCount, (count) => count + 1),
    );

    yield* reportProgress({ stage: "synchronizing", prepared });
    yield* session.ready;
    return { prepared, session } satisfies ConnectionDriver.EnvironmentConnectionLease;
  });

  const connect = Effect.fn("TestConnectionDriver.connect")(function* (
    entry: ConnectionCatalogEntry,
    reportProgress: (progress: ConnectionDriver.ConnectionDriverProgress) => Effect.Effect<void>,
    reportRouteFailure?: (failure: ConnectionRouteFailure) => Effect.Effect<void>,
  ) {
    yield* reportProgress({ stage: "preparing" });
    return yield* ConnectionDriver.connectOverRoutes(
      entry,
      checkRoute,
      (route) => connectRoute(route.target, reportProgress),
      reportRouteFailure,
    );
  });

  const layerDependencies = Layer.mergeAll(
    Layer.succeed(Random.Random, {
      nextDoubleUnsafe: () => 1 - Number.EPSILON,
      nextIntUnsafe: () => 0,
    }),
    Layer.succeed(Connectivity.Connectivity, connectivity),
    Layer.succeed(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({
        changes: SubscriptionRef.changes(wakeups).pipe(
          Stream.drop(1),
          Stream.map((event) => event.reason),
        ),
      }),
    ),
    Layer.succeed(
      ConnectionDriver.ConnectionDriver,
      ConnectionDriver.ConnectionDriver.of({
        connect,
        checkRoute: (_entry, route) => checkRoute(route),
        preflight: (_entry, route) =>
          checkRoute(route).pipe(Effect.map((check) => check === "answered")),
      }),
    ),
  );

  return {
    dependencies: layerDependencies,
    prepareCount,
    sessionCount,
    releaseCount,
    setNetworkStatus: (status: NetworkStatus) => SubscriptionRef.set(networkStatus, status),
    wake: (reason: ConnectionWakeups.ConnectionWakeup) =>
      SubscriptionRef.update(wakeups, (event) => ({
        sequence: event.sequence + 1,
        reason,
      })),
    closeLatestSession: Effect.fn("TestConnectionHarness.closeLatestSession")(function* (
      error = transient("Session closed."),
    ) {
      const sessions = yield* Ref.get(closedSessions);
      const latest = sessions.at(-1);
      if (latest) {
        yield* Deferred.fail(latest, error);
      }
    }),
  };
});

const RELAY_ENDPOINT = {
  httpBaseUrl: TARGET.httpBaseUrl,
  wsBaseUrl: TARGET.wsBaseUrl,
  providerKind: "cloudflare_tunnel" as const,
};

const RELAY_BOOTSTRAP: RelayEnvironmentConnectResponse = {
  environmentId: TARGET.environmentId,
  endpoint: RELAY_ENDPOINT,
  credential: "relay-bootstrap",
  expiresAt: "2026-09-04T01:00:00.000Z",
};

const relayToken = (accessToken: string, endpoint = RELAY_ENDPOINT) =>
  new TokenStore.RemoteDpopAccessToken({
    environmentId: TARGET.environmentId,
    accountId: "test-account",
    label: TARGET.label,
    endpoint,
    accessToken,
    expiresAtEpochMs: 3_600_000,
    dpopThumbprint: "test-thumbprint",
  });

/** Answers the descriptor, token exchange, and websocket ticket requests of a relay connect. */
function relayEnvironmentResponse(pathname: string): Promise<Response> {
  switch (pathname) {
    case "/.well-known/t3/environment":
      return Promise.resolve(
        Response.json({
          environmentId: TARGET.environmentId,
          label: TARGET.label,
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        }),
      );
    case "/oauth/token":
      return Promise.resolve(
        Response.json({
          access_token: "access-token-2",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "DPoP",
          expires_in: 3_600,
          scope: AuthStandardClientScopes.join(" "),
        }),
      );
    case "/api/auth/websocket-ticket/rpc":
      return Promise.resolve(
        Response.json({
          ticket: "ws-ticket",
          expiresAt: "2026-09-04T01:00:00.000Z",
        }),
      );
    default:
      return Promise.reject(new Error(`Unexpected HTTP request to ${pathname}`));
  }
}

/**
 * A relay environment server that never answers its first `stalledRequests` requests. When
 * `exchangeAnswered` is set, the token exchange answers only after it settles. `stalls` gets
 * one item per unanswered request so a test can move the clock past its timeout.
 */
const makeSlowRelayServer = Effect.fn("TestSlowRelayServer.make")(function* (input: {
  readonly stalledRequests: number;
  readonly exchangeAnswered?: Promise<void>;
}) {
  const stalls = yield* Queue.unbounded<void>();
  const paths: Array<string> = [];
  const fetchFn = ((request, init) => {
    const pathname = new URL(new Request(request, init).url).pathname;
    paths.push(pathname);
    if (paths.length <= input.stalledRequests) {
      Queue.offerUnsafe(stalls, undefined);
      return new Promise<Response>(() => {});
    }
    if (pathname === "/oauth/token" && input.exchangeAnswered) {
      Queue.offerUnsafe(stalls, undefined);
      return input.exchangeAnswered.then(() => relayEnvironmentResponse(pathname));
    }
    return relayEnvironmentResponse(pathname);
  }) satisfies typeof fetch;
  return { fetchFn, paths, stalls };
});

/**
 * Builds the real relay authorization service over a test fetch, one stored token, and a
 * relay that returns `bootstrap`. `prepare` plugs it into the test supervisor harness.
 */
const makeRelayAuthorization = Effect.fn("TestRelayAuthorization.make")(function* (input: {
  readonly token: TokenStore.RemoteDpopAccessToken;
  readonly fetchFn: typeof fetch;
  readonly bootstrap?: Effect.Effect<
    RelayEnvironmentConnectResponse,
    ManagedRelay.ManagedRelayClientError
  >;
}) {
  const token = yield* Ref.make(Option.some(input.token));
  const bootstrapCalls = yield* Ref.make(0);
  const signer = ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Effect.succeed("test-thumbprint"),
    createProof: () => Effect.succeed("test-proof"),
  });
  const unused = () => Effect.die("Unexpected relay operation.");
  const relay = ManagedRelay.ManagedRelayClient.of({
    relayUrl: "https://relay.example.test",
    listEnvironments: unused,
    listDevices: unused,
    createEnvironmentLinkChallenge: unused,
    linkEnvironment: unused,
    unlinkEnvironment: unused,
    getEnvironmentStatus: unused,
    connectEnvironment: () =>
      Ref.update(bootstrapCalls, (count) => count + 1).pipe(
        Effect.andThen(input.bootstrap ?? Effect.succeed(RELAY_BOOTSTRAP)),
      ),
    registerDevice: unused,
    unregisterDevice: unused,
    registerLiveActivity: unused,
    getAgentActivitySnapshot: unused,
    resetTokenCache: Effect.void,
  });
  const httpLayer = RpcHttp.layerRemoteHttpClient(input.fetchFn);
  const remoteAuthorization = yield* RemoteEnvironmentAuthorization.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        httpLayer,
        Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, signer),
        Layer.succeed(ManagedRelay.ManagedRelayClient, relay),
        Layer.succeed(ClientCapabilities.CloudSession, {
          identity: Effect.succeedSome({ accountId: "test-account" }),
          clerkToken: Effect.succeed("clerk-token"),
          missingSession: Effect.fail(
            new ConnectionBlockedError({ reason: "authentication", detail: "Signed out." }),
          ),
        }),
        Layer.succeed(ClientCapabilities.RelayDeviceIdentity, {
          deviceId: Effect.succeedNone,
        }),
        TokenStore.layer({
          get: () => Ref.get(token),
          put: (value) => Ref.set(token, Option.some(value)),
          remove: () => Ref.set(token, Option.none()),
        }),
        Layer.succeed(ClientCapabilities.ClientPresentation, {
          metadata: { label: "Test client", deviceType: "desktop" },
        }),
      ),
    ),
  );
  const prepare = () =>
    remoteAuthorization
      .authorizeDpop({ expectedEnvironmentId: TARGET.environmentId })
      .pipe(Effect.map((prepared) => ({ ...prepared, target: RELAY_TARGET })));
  return { remoteAuthorization, signer, httpLayer, bootstrapCalls, prepare };
});

describe("EnvironmentSupervisor", () => {
  it.effect("does not attempt a connection until it is desired", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY).pipe(
        Effect.provide(harness.dependencies),
      );

      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("available");
      expect(yield* Ref.get(harness.prepareCount)).toBe(0);
    }),
  );

  it.effect("does not let the initial connect signal cancel the first attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY).pipe(
        Effect.provide(harness.dependencies),
      );

      yield* supervisor.connect;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
    }),
  );

  it.effect("waits while offline and connects immediately when the network returns", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ networkStatus: "offline" });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "offline");
      expect(yield* Ref.get(harness.prepareCount)).toBe(0);

      yield* harness.setNetworkStatus("online");
      const ready = yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(ready).toMatchObject({
        desired: true,
        network: "online",
        phase: "connected",
        attempt: 1,
        generation: 1,
        lastFailure: null,
      });
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }),
  );

  it.effect("keeps the latest failure visible throughout the next connection attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(transient("Relay connection timed out.")) : Effect.never,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("3 seconds");

      const retrying = yield* awaitState(
        supervisor.state,
        (state) =>
          state.phase === "connecting" && state.stage === "preparing" && state.attempt === 2,
      );
      expect(retrying).toMatchObject({
        phase: "connecting",
        stage: "preparing",
        attempt: 2,
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "transport",
          message: "Relay connection timed out.",
        },
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("converts unexpected driver defects into retryable failures", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1
            ? Effect.die(new Error("Native transport defect."))
            : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      const failed = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      expect(failed).toMatchObject({
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "transport",
          message: "Test environment connection failed unexpectedly.",
        },
      });

      yield* TestClock.adjust("3 seconds");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("explicit retry interrupts the current backoff", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(transient()) : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      yield* supervisor.retryNow;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }),
  );

  it.effect("a mobile refocus restarts the retry ladder but never probes a live session", () =>
    Effect.gen(function* () {
      const probeCount = yield* Ref.make(0);
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt <= 2 ? Effect.fail(transient()) : Effect.succeed(PREPARED_CONNECTION),
        probe: () => Ref.update(probeCount, (count) => count + 1),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("3 seconds");
      yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 2,
      );
      yield* harness.wake("application-refocused");
      yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "connected" && state.attempt === 1,
      );

      yield* harness.wake("application-refocused");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(probeCount)).toBe(0);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps blocked failures idle until an external signal requests another attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(blocked()) : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "blocked");
      yield* TestClock.adjust("1 hour");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);

      yield* supervisor.retryNow;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("retries a blocked connection when platform credentials change", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(blocked()) : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "blocked");
      yield* harness.wake("credentials-changed");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }),
  );

  it.effect("does not let platform wakeups reset an in-flight attempt", () =>
    Effect.gen(function* () {
      const firstAttemptStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: () =>
          Deferred.succeed(firstAttemptStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(firstAttemptStarted);
      yield* Effect.all(
        [
          harness.wake("credentials-changed"),
          harness.wake("application-active"),
          harness.wake("credentials-changed"),
        ],
        { concurrency: "unbounded" },
      );
      yield* Effect.yieldNow;

      expect(yield* Ref.get(harness.prepareCount)).toBe(1);

      yield* TestClock.adjust("15 seconds");
      const retrying = yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );

      expect(retrying).toMatchObject({
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "timeout",
          message: "Test environment did not respond during connection setup.",
        },
      });
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(0);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("treats an involuntary session close as transient and reconnects", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);

      yield* TestClock.adjust("3 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(Option.isSome(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not report a session lost while suspended as a failed connection", () =>
    Effect.gen(function* () {
      const allowReconnect = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 2
            ? Deferred.await(allowReconnect).pipe(Effect.as(PREPARED_CONNECTION))
            : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      // The OS killed the socket while the app was suspended; its close arrives
      // before the app reports it is active again.
      yield* harness.closeLatestSession();
      const waiting = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      expect(presentConnectionState(waiting)).toEqual({
        phase: "reconnecting",
        error: null,
        traceId: null,
      });

      yield* harness.wake("application-active");
      const replacing = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting" && state.stage === "preparing",
      );
      expect(presentConnectionState(replacing).error).toBeNull();

      yield* Deferred.succeed(allowReconnect, undefined);
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("restarts the retry ladder when a long resume replaces a connected session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("2 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2 && state.attempt === 2,
      );

      yield* harness.wake("application-active-reconnect");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 3 && state.attempt === 1,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("restarts the retry ladder when a long resume interrupts connection setup", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) => (attempt === 2 ? Effect.never : Effect.succeed(PREPARED_CONNECTION)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("3 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting" && state.attempt === 2,
      );

      yield* harness.wake("application-active-reconnect");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2 && state.attempt === 1,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("probes the active session without reconnecting on application activation", () =>
    Effect.gen(function* () {
      const probeCount = yield* Ref.make(0);
      const probeCalled = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        probe: () =>
          Ref.update(probeCount, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(probeCalled, undefined)),
          ),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* Deferred.await(probeCalled);

      expect(yield* Ref.get(probeCount)).toBe(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connected");
    }),
  );

  it.effect("immediately replaces a mobile session after a long background resume", () =>
    Effect.gen(function* () {
      const probeCount = yield* Ref.make(0);
      const harness = yield* makeHarness({
        probe: () => Ref.update(probeCount, (count) => count + 1),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      yield* harness.wake("application-active-reconnect");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(probeCount)).toBe(0);
      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect("replaces a mobile session when a long resume interrupts an active probe", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      yield* harness.wake("application-active-probe");
      yield* Effect.yieldNow;
      yield* harness.wake("application-active-reconnect");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect("reconnects immediately when the session closes during a resume probe", () =>
    Effect.gen(function* () {
      const probeStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        probe: (attempt) =>
          attempt === 1
            ? Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* Deferred.await(probeStarted);
      yield* harness.closeLatestSession();

      const reconnected = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(reconnected.attempt).toBe(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reconnects immediately when the foreground liveness probe fails", () =>
    Effect.gen(function* () {
      const allowReconnect = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 2
            ? Deferred.await(allowReconnect).pipe(Effect.as(PREPARED_CONNECTION))
            : Effect.succeed(PREPARED_CONNECTION),
        probe: (attempt) =>
          attempt === 1 ? Effect.fail(transient("The live session is stale.")) : Effect.void,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      const reconnecting = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting",
      );
      expect(reconnecting.attempt).toBe(1);
      expect(reconnecting.lastFailure).toBeNull();
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);

      yield* Deferred.succeed(allowReconnect, undefined);
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2 && state.attempt === 1,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("extends a retry-shortened probe by the retry's window when data arrives", () =>
    Effect.gen(function* () {
      const frames = yield* Ref.make(0);
      const harness = yield* makeHarness({
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
        receivedFrames: Ref.get(frames),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* TestClock.adjust("1 second");
      yield* supervisor.retryNow;
      yield* TestClock.adjust("1 second");
      yield* Ref.set(frames, 1);
      // The retry's deadline lands at 7 seconds and the data extends it by the
      // retry's 6 seconds to 13, not by the original 15.
      yield* TestClock.adjust("10999 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      yield* TestClock.adjust("1 milli");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps waiting on a quick probe while data still arrives, up to the full timeout", () =>
    Effect.gen(function* () {
      const frames = yield* Ref.make(0);
      const harness = yield* makeHarness({
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
        receivedFrames: Ref.get(frames),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* TestClock.adjust("5 seconds");
      yield* Ref.set(frames, 1);
      yield* TestClock.adjust("6 seconds");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);

      // Frames keep arriving, but the probe still gets no more than 15 seconds.
      yield* Ref.set(frames, 2);
      yield* TestClock.adjust("3999 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      yield* Ref.set(frames, 3);
      yield* TestClock.adjust("1 milli");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("times out a quick probe once data stops arriving", () =>
    Effect.gen(function* () {
      const frames = yield* Ref.make(0);
      const harness = yield* makeHarness({
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
        receivedFrames: Ref.get(frames),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* TestClock.adjust("1 second");
      yield* Ref.set(frames, 1);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      yield* TestClock.adjust("6 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("honors an explicit disconnect while a foreground probe is stalled", () =>
    Effect.gen(function* () {
      const probeStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        probe: () => Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* Deferred.await(probeStarted);
      yield* supervisor.disconnect;
      yield* awaitState(supervisor.state, (state) => state.phase === "available");

      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect("does not churn a healthy session when credentials change", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("credentials-changed");
      yield* Effect.yieldNow;

      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connected");
    }),
  );

  it.effect("releases and reconnects a relay session when credentials change", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: () => Effect.succeed(preparedFor(RELAY_TARGET)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("credentials-changed");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect("refreshes HTTP authorization without replacing the active relay session", () =>
    Effect.gen(function* () {
      const bootstrapFails = yield* Ref.make(false);
      const httpPaths: Array<string> = [];
      const sessionAuthorizations: Array<string | null> = [];
      const fetchFn = ((input, init) => {
        const request = new Request(input, init);
        const pathname = new URL(request.url).pathname;
        httpPaths.push(pathname);
        if (pathname !== "/api/auth/session") {
          return relayEnvironmentResponse(pathname);
        }
        const authorization = request.headers.get("authorization");
        sessionAuthorizations.push(authorization);
        return Promise.resolve(
          Response.json({
            authenticated: authorization === "DPoP access-token-2",
            auth: {
              policy: "loopback-browser",
              bootstrapMethods: ["one-time-token"],
              sessionMethods: ["dpop-access-token"],
              sessionCookieName: "t3_session_test",
            },
            scopes: AuthStandardClientScopes,
          }),
        );
      }) satisfies typeof fetch;
      const relay = yield* makeRelayAuthorization({
        token: relayToken("access-token-1"),
        fetchFn,
        bootstrap: Effect.gen(function* () {
          if (yield* Ref.get(bootstrapFails)) {
            return yield* new ManagedRelay.ManagedRelayRequestTimeoutError({
              activity: "Relay environment connection",
              timeoutMs: 6_000,
              traceId: null,
            });
          }
          return RELAY_BOOTSTRAP;
        }),
      });
      const harness = yield* makeHarness({ prepare: relay.prepare });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      // A healthy server connects in the first attempt with the stored token, one ticket
      // request, no relay call, and no clock time.
      const connected = yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(connected).toMatchObject({ attempt: 1, lastFailure: null });
      expect(yield* Ref.get(relay.bootstrapCalls)).toBe(0);
      expect(httpPaths).toEqual(["/api/auth/websocket-ticket/rpc"]);
      const session = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      expect(prepared.httpAuthorization).toMatchObject({ accessToken: "access-token-1" });
      const readSession = fetchEnvironmentSessionState({
        prepared,
        signer: Option.some(relay.signer),
        remoteAuthorization: Option.some(relay.remoteAuthorization),
      }).pipe(Effect.provide(relay.httpLayer));

      yield* TestClock.adjust("2 hours");
      expect((yield* readSession).authenticated).toBe(true);
      expect(sessionAuthorizations).toEqual(["DPoP access-token-2"]);
      expect(yield* Ref.get(relay.bootstrapCalls)).toBe(1);
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session))).toBe(session);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 1,
      });

      yield* TestClock.adjust("2 hours");
      yield* Ref.set(bootstrapFails, true);
      const failure = yield* readSession.pipe(Effect.flip);
      expect(failure._tag).toBe("RemoteEnvironmentAuthFetchError");
      expect(yield* Ref.get(relay.bootstrapCalls)).toBe(2);
      expect(sessionAuthorizations).toEqual(["DPoP access-token-2"]);
      expect(httpPaths.filter((path) => path === "/api/auth/websocket-ticket/rpc")).toHaveLength(1);
      expect(httpPaths.filter((path) => path === "/oauth/token")).toHaveLength(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session))).toBe(session);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 1,
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("retries a lost relay ticket request with the stored token in the first attempt", () =>
    Effect.gen(function* () {
      const server = yield* makeSlowRelayServer({ stalledRequests: 1 });
      const relay = yield* makeRelayAuthorization({
        token: relayToken("stored-token"),
        fetchFn: server.fetchFn,
      });
      const harness = yield* makeHarness({ prepare: relay.prepare });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Queue.take(server.stalls);
      yield* TestClock.adjust("3 seconds");
      const settled = yield* awaitState(supervisor.state, (state) => state.phase !== "connecting");
      expect(settled).toMatchObject({ phase: "connected", attempt: 1, lastFailure: null });
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      expect(prepared.httpAuthorization).toMatchObject({ accessToken: "stored-token" });
      expect(yield* Ref.get(relay.bootstrapCalls)).toBe(0);
      expect(server.paths).toEqual([
        "/api/auth/websocket-ticket/rpc",
        "/api/auth/websocket-ticket/rpc",
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reconnects to a stalled relay server with its stored token", () =>
    Effect.gen(function* () {
      const server = yield* makeSlowRelayServer({ stalledRequests: 2 });
      const relay = yield* makeRelayAuthorization({
        token: relayToken("stored-token"),
        fetchFn: server.fetchFn,
      });
      const harness = yield* makeHarness({ prepare: relay.prepare });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Queue.take(server.stalls);
      yield* TestClock.adjust("3 seconds");
      yield* Queue.take(server.stalls);
      // The first request and its retry share a 10 s ticket budget.
      yield* TestClock.adjust("6 seconds");
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({ phase: "connecting" });
      yield* TestClock.adjust("1 second");
      const failed = yield* awaitState(supervisor.state, (state) => state.phase !== "connecting");
      // The relay and tunnel answered for this token before, so the failure does not
      // blame the user's network.
      expect(failed).toMatchObject({
        phase: "backoff",
        attempt: 1,
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "timeout",
          detail: "Test environment did not respond during connection setup.",
        },
      });
      expect(yield* Ref.get(relay.bootstrapCalls)).toBe(0);

      yield* TestClock.adjust("3 seconds");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      expect(prepared.httpAuthorization).toMatchObject({ accessToken: "stored-token" });
      expect(yield* Ref.get(relay.bootstrapCalls)).toBe(0);
      expect(server.paths).toEqual(Array(3).fill("/api/auth/websocket-ticket/rpc"));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("asks the relay once after three stalled attempts and connects with that token", () =>
    Effect.gen(function* () {
      let answerExchange = () => {};
      const exchangeAnswered = new Promise<void>((resolve) => {
        answerExchange = resolve;
      });
      const server = yield* makeSlowRelayServer({ stalledRequests: 6, exchangeAnswered });
      const relay = yield* makeRelayAuthorization({
        token: relayToken("stored-token"),
        fetchFn: server.fetchFn,
      });
      const harness = yield* makeHarness({ prepare: relay.prepare });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      const stallTicketStep = Effect.gen(function* () {
        yield* Queue.take(server.stalls);
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(server.stalls);
        yield* TestClock.adjust("7 seconds");
      });

      for (const [attempt, backoff] of [
        [1, "2 seconds"],
        [2, "4 seconds"],
      ] as const) {
        yield* stallTicketStep;
        yield* awaitState(
          supervisor.state,
          (state) => state.phase === "backoff" && state.attempt === attempt,
        );
        expect(yield* Ref.get(relay.bootstrapCalls)).toBe(0);
        yield* TestClock.adjust(backoff);
      }

      // The third timeout asks the relay. The slow server holds the token exchange past the
      // 15 s setup deadline, 10 s of which the ticket step used.
      yield* stallTicketStep;
      yield* Queue.take(server.stalls);
      expect(yield* Ref.get(relay.bootstrapCalls)).toBe(1);
      yield* TestClock.adjust("4 seconds");
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({ phase: "connecting" });
      yield* TestClock.adjust("1 second");
      const failed = yield* awaitState(supervisor.state, (state) => state.phase !== "connecting");
      expect(failed).toMatchObject({ phase: "backoff", attempt: 3 });
      expect(failed.lastFailure?.detail).toContain("did not respond during connection setup");

      // The exchange still lands after the attempt ended, so the next attempt reuses it.
      answerExchange();
      yield* TestClock.adjust("8 seconds");
      const connected = yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(connected.attempt).toBe(4);
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      expect(prepared.httpAuthorization).toMatchObject({ accessToken: "access-token-2" });
      expect(yield* Ref.get(relay.bootstrapCalls)).toBe(1);
      expect(server.paths.slice(6)).toEqual([
        "/.well-known/t3/environment",
        "/oauth/token",
        "/api/auth/websocket-ticket/rpc",
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("moves to a new relay endpoint within the first attempt", () =>
    Effect.gen(function* () {
      const oldEndpoint = {
        ...RELAY_ENDPOINT,
        httpBaseUrl: "https://old-environment.example.test",
        wsBaseUrl: "wss://old-environment.example.test",
      };
      const fetchFn = ((input, init) => {
        const url = new URL(new Request(input, init).url);
        return url.origin === oldEndpoint.httpBaseUrl
          ? Promise.reject(new TypeError("getaddrinfo ENOTFOUND old-environment.example.test"))
          : relayEnvironmentResponse(url.pathname);
      }) satisfies typeof fetch;
      const relay = yield* makeRelayAuthorization({
        token: relayToken("old-token", oldEndpoint),
        fetchFn,
      });
      const harness = yield* makeHarness({ prepare: relay.prepare });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      // No clock time passes: the failed request re-bootstraps through the relay at once.
      const settled = yield* awaitState(supervisor.state, (state) => state.phase !== "connecting");
      expect(settled).toMatchObject({ phase: "connected", attempt: 1, lastFailure: null });
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      expect(prepared.httpBaseUrl).toBe(RELAY_ENDPOINT.httpBaseUrl);
      expect(prepared.httpAuthorization).toMatchObject({ accessToken: "access-token-2" });
      expect(yield* Ref.get(relay.bootstrapCalls)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not lose an explicit disconnect among concurrent wakeup signals", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* Effect.all(
        [
          supervisor.disconnect,
          harness.wake("credentials-changed"),
          harness.wake("application-active"),
          harness.wake("credentials-changed"),
        ],
        { concurrency: "unbounded" },
      );
      yield* awaitState(supervisor.state, (state) => state.phase === "available");

      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);
    }),
  );
});

describe("EnvironmentSupervisor routes", () => {
  it.effect("records why each route failed when every route fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          Effect.succeed(route.target._tag === "BearerConnectionTarget" ? "silent" : "unchecked"),
        prepare: () => Effect.fail(transient("Relay could not reach the environment endpoint.")),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      const state = yield* awaitState(supervisor.state, (value) => value.phase === "backoff");
      expect(state.routeFailures.map((failure) => [failure.routeId, failure._tag])).toEqual([
        ["bearer:lan", "NoAnswer"],
        ["relay", "Failed"],
      ]);

      yield* supervisor.disconnect;
      const available = yield* awaitState(supervisor.state, (value) => value.phase === "available");
      expect(available.routeFailures).toEqual([]);
    }),
  );

  it.effect("keeps the failures of routes ahead of the one in use", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: () => Effect.succeed("answered"),
        prepare: (_attempt, target) =>
          target._tag === "BearerConnectionTarget"
            ? Effect.fail(blocked("The environment credential is invalid."))
            : Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      const state = yield* awaitState(supervisor.state, (value) => value.phase === "connected");
      expect(state.routeFailures).toEqual([
        {
          _tag: "Failed",
          routeId: "bearer:lan",
          error: blocked("The environment credential is invalid."),
        },
      ]);
    }),
  );

  it.effect("keeps the routes it heard from when setup times out", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          Effect.succeed(route.target._tag === "BearerConnectionTarget" ? "silent" : "unchecked"),
        prepare: () => Effect.never,
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (value) => value.stage === "preparing");
      yield* TestClock.adjust("31 seconds");
      const state = yield* awaitState(supervisor.state, (value) => value.phase === "backoff");
      expect(state.lastFailure?.reason).toBe("timeout");
      expect(state.routeFailures).toEqual([{ _tag: "NoAnswer", routeId: "bearer:lan" }]);
    }),
  );

  it.effect("skips a silent LAN route and connects over T3 Connect", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          Effect.succeed(route.target._tag === "BearerConnectionTarget" ? "silent" : "unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      expect(prepared.target._tag).toBe("RelayConnectionTarget");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }),
  );

  it.effect("moves to a blocked route's fallback instead of stopping", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: () => Effect.succeed("answered"),
        prepare: (_attempt, target) =>
          target._tag === "BearerConnectionTarget"
            ? Effect.fail(blocked("The environment credential is invalid."))
            : Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      expect(prepared.target._tag).toBe("RelayConnectionTarget");
    }),
  );

  it.effect("tries every route when none answers the reachability check", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: () => Effect.succeed("silent"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      expect(prepared.target._tag).toBe("BearerConnectionTarget");
    }),
  );

  it.effect("keeps retrying when one route is blocked and another failed transiently", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: () => Effect.succeed("answered"),
        prepare: (_attempt, target) =>
          target._tag === "RelayConnectionTarget"
            ? Effect.fail(blocked("Sign in to T3 Connect."))
            : Effect.fail(transient("LAN socket refused.")),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      const state = yield* awaitState(supervisor.state, (value) => value.phase === "backoff");
      expect(state.lastFailure?._tag).toBe("ConnectionTransientError");
    }),
  );

  it.effect("moves back to the LAN route when the network changes and it answers again", () =>
    Effect.gen(function* () {
      const lanReachable = yield* Ref.make(false);
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Ref.get(lanReachable).pipe(
                Effect.map((reachable) => (reachable ? "answered" : "silent")),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "RelayConnectionTarget",
      );

      yield* Ref.set(lanReachable, true);
      yield* harness.setNetworkStatus("unknown");
      yield* harness.setNetworkStatus("online");

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect("stays on T3 Connect longer each time a switched-to LAN session drops", () =>
    Effect.gen(function* () {
      const lanAnswers = yield* Ref.make(false);
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Ref.get(lanAnswers).pipe(Effect.map((answers) => (answers ? "answered" : "silent")))
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      const connected = Effect.fnUntraced(function* (generation: number) {
        yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected" && state.generation === generation,
        );
        return Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag;
      });
      // A dropped session backs off for 2 s before it reconnects.
      const dropSession = Effect.gen(function* () {
        yield* harness.closeLatestSession();
        yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
        yield* TestClock.adjust("2 seconds");
      });
      const stillConnected = Effect.fnUntraced(function* (generation: number) {
        yield* Effect.yieldNow;
        expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
          phase: "connected",
          generation,
        });
      });

      expect(yield* connected(1)).toBe("RelayConnectionTarget");
      yield* Ref.set(lanAnswers, true);
      yield* TestClock.adjust("60 seconds");
      expect(yield* connected(2)).toBe("BearerConnectionTarget");

      // The LAN keeps answering its check, but its session drops a minute
      // after the switch. The reconnect tries T3 Connect first.
      yield* TestClock.adjust("60 seconds");
      yield* dropSession;
      expect(yield* connected(3)).toBe("RelayConnectionTarget");

      // The periodic check leaves the session alone for five minutes.
      yield* TestClock.adjust("4 minutes");
      yield* stillConnected(3);
      yield* TestClock.adjust("1 minute");
      expect(yield* connected(4)).toBe("BearerConnectionTarget");

      // A second drop doubles the wait to ten minutes.
      yield* TestClock.adjust("60 seconds");
      yield* dropSession;
      expect(yield* connected(5)).toBe("RelayConnectionTarget");
      yield* TestClock.adjust("9 minutes");
      yield* stillConnected(5);
      yield* TestClock.adjust("1 minute");
      expect(yield* connected(6)).toBe("BearerConnectionTarget");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("switches straight back to a LAN whose session held before it dropped", () =>
    Effect.gen(function* () {
      const lanAnswers = yield* Ref.make(false);
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Ref.get(lanAnswers).pipe(Effect.map((answers) => (answers ? "answered" : "silent")))
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      yield* Ref.set(lanAnswers, true);
      yield* TestClock.adjust("60 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      // The server restarts after the LAN session has run for ten minutes.
      yield* TestClock.adjust("10 minutes");
      yield* harness.closeLatestSession();
      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      yield* TestClock.adjust("2 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 3,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("backs off instead of trying a silent LAN after T3 Connect failed transiently", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          Effect.succeed(route.target._tag === "BearerConnectionTarget" ? "silent" : "unchecked"),
        prepare: (_attempt, target) =>
          target._tag === "RelayConnectionTarget"
            ? Effect.fail(transient("Relay environment connection timed out."))
            : Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      const state = yield* awaitState(supervisor.state, (value) => value.phase === "backoff");
      expect(state.lastFailure?.detail).toBe("Relay environment connection timed out.");
      // Only T3 Connect reached the resolver.
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }),
  );

  it.effect("moves off a dead LAN socket when the phone switches to cellular", () =>
    Effect.gen(function* () {
      const lanReachable = yield* Ref.make(true);
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Ref.get(lanReachable).pipe(
                Effect.map((reachable) => (reachable ? "answered" : "silent")),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        probe: () =>
          Ref.get(lanReachable).pipe(
            Effect.flatMap((reachable) => (reachable ? Effect.void : Effect.never)),
          ),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );

      yield* Ref.set(lanReachable, false);
      yield* harness.wake("network-changed");
      yield* TestClock.adjust("6 seconds");

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "RelayConnectionTarget",
      );
    }),
  );

  it.effect("learns the LAN address over T3 Connect and moves to it", () =>
    Effect.gen(function* () {
      const relayEntry: ConnectionCatalogEntry = {
        target: RELAY_TARGET,
        profile: Option.none(),
        enabled: true,
      };
      const lanAddress = yield* Ref.make("http://192.168.1.10:3773/");
      const learned = yield* Ref.make<ReadonlyArray<string>>([]);
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Effect.succeed("answered")
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        initialConfig: () =>
          Ref.get(lanAddress).pipe(
            Effect.map((httpBaseUrl): Pick<ServerConfig, "directEndpoints"> => ({
              directEndpoints: [{ kind: "lan", httpBaseUrl }],
            })),
            Effect.map((config) => config as ServerConfig),
          ),
      });
      const current = yield* Ref.make(relayEntry);
      const supervisor = yield* EnvironmentSupervisor.make(relayEntry, {
        initiallyDesired: true,
        learnRoutes: ({ activeRoute, reported }) =>
          Effect.gen(function* () {
            const entry = yield* Ref.get(current);
            const routes = mergeLearnedRoutes({
              entry,
              activeRoute,
              reported,
              allowInsecure: true,
            });
            if (routes === null) return Option.none();
            const next = entryWithRoutes(entry, routes);
            yield* Ref.set(current, next);
            yield* Ref.update(learned, (all) => [
              ...all,
              ...routes.filter(isLearned).map((route) => connectionRouteId(route.target)),
            ]);
            return Option.some(next);
          }),
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );
      expect(yield* Ref.get(learned)).toEqual([
        `learned:${TARGET.environmentId}:http://192.168.1.10:3773`,
      ]);
    }),
  );
});
