import { EnvironmentId } from "@t3tools/contracts";
import {
  RelayAccountScope,
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ManagedRelay from "./managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";
import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";

const encodeRelayError = Schema.encodeEffect(ManagedRelay.ManagedRelayClientError);
const decodeRelayError = Schema.decodeUnknownEffect(ManagedRelay.ManagedRelayClientError);

function layerManagedRelayTest(
  fetchFn: typeof globalThis.fetch,
  relayUrl = "https://relay.example.test",
  accessTokenStore?: ManagedRelay.ManagedRelayAccessTokenStore,
  onSessionEnded?: ManagedRelay.ManagedRelayClientLayerOptions["onSessionEnded"],
) {
  const layerHttpClient = RpcHttp.layerRemoteHttpClient(fetchFn);
  const layerSigner = Layer.succeed(
    ManagedRelay.ManagedRelayDpopSigner,
    ManagedRelay.ManagedRelayDpopSigner.of({
      thumbprint: Effect.succeed("client-thumbprint"),
      createProof: (input: ManagedRelay.ManagedRelayDpopProofInput) =>
        Effect.succeed(`proof:${input.url}`),
    }),
  );
  return ManagedRelay.layer({
    relayUrl,
    clientId: "t3-mobile",
    ...(accessTokenStore ? { accessTokenStore } : {}),
    ...(onSessionEnded ? { onSessionEnded } : {}),
  }).pipe(Layer.provide(layerSigner), Layer.provide(layerHttpClient));
}

function credential(accountId: string): ManagedRelay.ManagedRelayCredential {
  return { accountId, refreshToken: `styal_rt_${accountId}` };
}

/** A store already holding a usable account token, so a request skips the refresh. */
function seededAccountTokenStore(accessToken = "seeded-account-token") {
  let entries: ReadonlyArray<ManagedRelay.ManagedRelayAccessTokenCacheEntry> = [
    {
      accountId: "user-1",
      clientId: "t3-mobile",
      relayUrl: "https://relay.example.test",
      thumbprint: "client-thumbprint",
      scopes: [RelayAccountScope],
      accessToken,
      expiresAtMillis: Number.MAX_SAFE_INTEGER,
    },
  ];
  return {
    store: {
      load: Effect.sync(() => entries),
      save: (next) =>
        Effect.sync(() => {
          entries = next;
        }),
      clear: Effect.sync(() => {
        entries = [];
      }),
    } satisfies ManagedRelay.ManagedRelayAccessTokenStore,
    entries: () => entries,
  };
}

const accessTokenResponse = (accessToken: string, scope: string, expiresIn = 1_800) =>
  Response.json({
    access_token: accessToken,
    token_type: "DPoP",
    expires_in: expiresIn,
    scope,
    user: { id: "user-1", email: "someone@example.com" },
  });

describe("ManagedRelayClient", () => {
  it.effect("owns tracing at service and implementation boundaries", () => {
    const spanNames: Array<string> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spanNames.push(span.name);
        return span;
      },
    });
    const fetchFn = ((input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/token")) {
        return Promise.resolve(
          accessTokenResponse("relay-token", RelayEnvironmentStatusScope, 1_800),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: "env-1",
          endpoint: {
            httpBaseUrl: "https://desktop.example.test/",
            wsBaseUrl: "wss://desktop.example.test/ws",
            providerKind: "cloudflare_tunnel",
          },
          status: "online",
          checkedAt: "2026-06-05T20:00:00.000Z",
          descriptor: {
            environmentId: "env-1",
            label: "Desktop",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        }),
      );
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      yield* relayClient.getEnvironmentStatus({
        credential: credential("user-1"),
        scopes: [RelayEnvironmentStatusScope],
        environmentId: EnvironmentId.make("env-1"),
      });

      expect(spanNames).toEqual(
        expect.arrayContaining([
          "clientRuntime.managedRelay.getEnvironmentStatus",
          "clientRuntime.managedRelay.authorize",
          "clientRuntime.managedRelay.obtainAccessToken",
          "clientRuntime.managedRelay.tokenCacheCriticalSection",
          "clientRuntime.managedRelay.refreshAccessToken",
        ]),
      );
      expect(spanNames).not.toEqual(
        expect.arrayContaining([
          "clientRuntime.managedRelay.createTokenExchangeProof",
          "clientRuntime.managedRelay.exchangeAccessTokenRequest",
          "clientRuntime.managedRelay.createRequestProof",
        ]),
      );
    }).pipe(Effect.withTracer(tracer), Effect.provide(layerManagedRelayTest(fetchFn)));
  });

  it.effect("rejects unsafe relay URLs before sending credentials", () => {
    let requestCount = 0;
    const fetchFn = (() => {
      requestCount += 1;
      return Promise.resolve(Response.json({}));
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const error = yield* relayClient
        .listEnvironments({ credential: credential("user-1") })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "ManagedRelayUrlInvalidError",
        relayUrl: "http://relay.example.test",
        message: "Relay URL must be a secure absolute HTTPS origin.",
      });
      expect(requestCount).toBe(0);
    }).pipe(Effect.provide(layerManagedRelayTest(fetchFn, "http://relay.example.test")));
  });

  it.effect("reuses usable DPoP tokens and refreshes cleared or expiring cache entries", () => {
    let tokenExchangeCount = 0;
    const fetchFn = ((input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/token")) {
        tokenExchangeCount += 1;
        return Promise.resolve(
          accessTokenResponse(`relay-token-${tokenExchangeCount}`, RelayEnvironmentStatusScope, 10),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: "env-1",
          endpoint: {
            httpBaseUrl: "https://desktop.example.test/",
            wsBaseUrl: "wss://desktop.example.test/ws",
            providerKind: "cloudflare_tunnel",
          },
          status: "online",
          checkedAt: "2026-05-25T00:01:00.000Z",
          descriptor: {
            environmentId: "env-1",
            label: "Desktop",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        }),
      );
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const statusInput = {
        credential: credential("user-1"),
        scopes: [RelayEnvironmentStatusScope],
        environmentId: EnvironmentId.make("env-1"),
      } as const;

      yield* relayClient.getEnvironmentStatus(statusInput);
      yield* relayClient.getEnvironmentStatus(statusInput);
      expect(tokenExchangeCount).toBe(1);

      yield* TestClock.adjust(Duration.seconds(6));
      yield* relayClient.getEnvironmentStatus(statusInput);
      expect(tokenExchangeCount).toBe(2);

      yield* relayClient.resetTokenCache;
      yield* relayClient.getEnvironmentStatus(statusInput);
      expect(tokenExchangeCount).toBe(3);
    }).pipe(Effect.provide(layerManagedRelayTest(fetchFn)));
  });

  it.effect("uses a cached token while another scope waits for an exchange", () => {
    const exchangeStarted = Promise.withResolvers<void>();
    const releaseExchange = Promise.withResolvers<void>();
    let tokenExchangeCount = 0;
    const statusTokens: Array<string | null> = [];
    let persistedTokens: ReadonlyArray<ManagedRelay.ManagedRelayAccessTokenCacheEntry> = [
      {
        accountId: "user-1",
        clientId: "t3-mobile",
        relayUrl: "https://relay.example.test",
        thumbprint: "client-thumbprint",
        scopes: [RelayEnvironmentStatusScope],
        accessToken: "cached-status-token",
        expiresAtMillis: Number.MAX_SAFE_INTEGER,
      },
    ];
    const accessTokenStore: ManagedRelay.ManagedRelayAccessTokenStore = {
      load: Effect.sync(() => persistedTokens),
      save: (entries) =>
        Effect.sync(() => {
          persistedTokens = entries;
        }),
      clear: Effect.sync(() => {
        persistedTokens = [];
      }),
    };
    const fetchFn = ((input, init) => {
      if (String(input).endsWith("/v1/auth/token")) {
        tokenExchangeCount += 1;
        exchangeStarted.resolve();
        return releaseExchange.promise.then(() =>
          accessTokenResponse(
            "expanded-scope-token",
            `${RelayEnvironmentStatusScope} ${RelayEnvironmentConnectScope}`,
            1_800,
          ),
        );
      }
      statusTokens.push(new Headers(init?.headers).get("authorization"));
      return Promise.resolve(
        Response.json({
          environmentId: "env-1",
          endpoint: {
            httpBaseUrl: "https://desktop.example.test/",
            wsBaseUrl: "wss://desktop.example.test/ws",
            providerKind: "cloudflare_tunnel",
          },
          status: "online",
          checkedAt: "2026-09-04T00:00:00.000Z",
        }),
      );
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const statusInput = {
        credential: credential("user-1"),
        scopes: [RelayEnvironmentStatusScope],
        environmentId: EnvironmentId.make("env-1"),
      } as const;
      const expandedScopeInput = {
        ...statusInput,
        scopes: [RelayEnvironmentStatusScope, RelayEnvironmentConnectScope],
      } as const;
      const firstMiss = yield* relayClient
        .getEnvironmentStatus(expandedScopeInput)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => exchangeStarted.promise);
      const secondMiss = yield* relayClient
        .getEnvironmentStatus(expandedScopeInput)
        .pipe(Effect.forkChild);

      const status = yield* relayClient.getEnvironmentStatus(statusInput);
      expect(status.status).toBe("online");
      expect(statusTokens).toEqual(["DPoP cached-status-token"]);

      releaseExchange.resolve();
      yield* Fiber.join(firstMiss);
      yield* Fiber.join(secondMiss);
      expect(tokenExchangeCount).toBe(1);
      // One token per account: the wider one replaces the narrower one.
      expect(persistedTokens.map((token) => token.accessToken)).toEqual(["expanded-scope-token"]);
      yield* relayClient.resetTokenCache;
      expect(persistedTokens).toEqual([]);
      yield* relayClient.getEnvironmentStatus(expandedScopeInput);
      expect(tokenExchangeCount).toBe(2);
    }).pipe(
      Effect.ensuring(Effect.sync(() => releaseExchange.resolve())),
      Effect.provide(layerManagedRelayTest(fetchFn, undefined, accessTokenStore)),
    );
  });

  it.effect("reuses a persisted token across runtimes", () => {
    let tokenExchangeCount = 0;
    let persistedTokens: ReadonlyArray<ManagedRelay.ManagedRelayAccessTokenCacheEntry> = [];
    const accessTokenStore: ManagedRelay.ManagedRelayAccessTokenStore = {
      load: Effect.sync(() => persistedTokens),
      save: (entries) =>
        Effect.sync(() => {
          persistedTokens = entries;
        }),
      clear: Effect.sync(() => {
        persistedTokens = [];
      }),
    };
    const fetchFn = ((input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/token")) {
        tokenExchangeCount += 1;
        return Promise.resolve(
          accessTokenResponse("persisted-relay-token", RelayEnvironmentStatusScope, 1_800),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: "env-1",
          endpoint: {
            httpBaseUrl: "https://desktop.example.test/",
            wsBaseUrl: "wss://desktop.example.test/ws",
            providerKind: "cloudflare_tunnel",
          },
          status: "online",
          checkedAt: "2026-06-05T20:00:00.000Z",
          descriptor: {
            environmentId: "env-1",
            label: "Desktop",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        }),
      );
    }) satisfies typeof globalThis.fetch;
    const statusInput = (accountId: string) =>
      ({
        credential: credential(accountId),
        scopes: [RelayEnvironmentStatusScope],
        environmentId: EnvironmentId.make("env-1"),
      }) as const;

    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const relayClient = yield* ManagedRelay.ManagedRelayClient;
        yield* relayClient.getEnvironmentStatus(statusInput("user-1"));
      }).pipe(Effect.provide(layerManagedRelayTest(fetchFn, undefined, accessTokenStore)));

      expect(tokenExchangeCount).toBe(1);
      expect(persistedTokens).toHaveLength(1);

      yield* Effect.gen(function* () {
        const relayClient = yield* ManagedRelay.ManagedRelayClient;
        yield* relayClient.getEnvironmentStatus(statusInput("user-1"));
      }).pipe(Effect.provide(layerManagedRelayTest(fetchFn, undefined, accessTokenStore)));

      expect(tokenExchangeCount).toBe(1);
    });
  });

  it.effect("refreshes a persisted DPoP token once when the relay rejects it", () => {
    let tokenExchangeCount = 0;
    const statusTokens: Array<string | null> = [];
    let persistedTokens: ReadonlyArray<ManagedRelay.ManagedRelayAccessTokenCacheEntry> = [
      {
        accountId: "user-1",
        clientId: "t3-mobile",
        relayUrl: "https://relay.example.test",
        thumbprint: "client-thumbprint",
        scopes: [RelayEnvironmentStatusScope],
        accessToken: "stale-relay-token",
        expiresAtMillis: Number.MAX_SAFE_INTEGER,
      },
    ];
    const accessTokenStore: ManagedRelay.ManagedRelayAccessTokenStore = {
      load: Effect.sync(() => persistedTokens),
      save: (entries) =>
        Effect.sync(() => {
          persistedTokens = entries;
        }),
      clear: Effect.sync(() => {
        persistedTokens = [];
      }),
    };
    const fetchFn = ((input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/token")) {
        tokenExchangeCount += 1;
        return Promise.resolve(
          accessTokenResponse("fresh-relay-token", RelayEnvironmentStatusScope, 1_800),
        );
      }

      const authorization = new Headers(init?.headers).get("authorization");
      statusTokens.push(authorization);
      if (authorization === "DPoP stale-relay-token") {
        return Promise.resolve(
          Response.json(
            {
              _tag: "RelayAuthInvalidError",
              code: "auth_invalid",
              reason: "invalid_bearer",
              traceId: "trace-stale-token",
            },
            { status: 401 },
          ),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: "env-1",
          endpoint: {
            httpBaseUrl: "https://desktop.example.test/",
            wsBaseUrl: "wss://desktop.example.test/ws",
            providerKind: "cloudflare_tunnel",
          },
          status: "online",
          checkedAt: "2026-06-05T20:00:00.000Z",
          descriptor: {
            environmentId: "env-1",
            label: "Desktop",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        }),
      );
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const result = yield* relayClient.getEnvironmentStatus({
        credential: credential("user-1"),
        scopes: [RelayEnvironmentStatusScope],
        environmentId: EnvironmentId.make("env-1"),
      });

      expect(result.status).toBe("online");
      expect(statusTokens).toEqual(["DPoP stale-relay-token", "DPoP fresh-relay-token"]);
      expect(tokenExchangeCount).toBe(1);
      expect(persistedTokens).toMatchObject([
        {
          accessToken: "fresh-relay-token",
        },
      ]);
    }).pipe(Effect.provide(layerManagedRelayTest(fetchFn, undefined, accessTokenStore)));
  });

  it.effect("times out stalled relay environment listing requests", () => {
    const fetchFn = (() =>
      new Promise<Response>(() => undefined)) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const errorFiber = yield* relayClient
        .listEnvironments({ credential: credential("user-1") })
        .pipe(Effect.flip, Effect.forkScoped);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(ManagedRelay.MANAGED_RELAY_REQUEST_TIMEOUT_MS));
      const error = yield* Fiber.join(errorFiber);

      expect(error).toMatchObject({
        _tag: "ManagedRelayRequestTimeoutError",
        activity: "Relay environment listing",
        timeoutMs: ManagedRelay.MANAGED_RELAY_REQUEST_TIMEOUT_MS,
        message: `Relay environment listing timed out. ${NETWORK_BLOCKING_HINT}`,
      });
    }).pipe(
      Effect.provide(
        Layer.merge(
          TestClock.layer(),
          layerManagedRelayTest(fetchFn, undefined, seededAccountTokenStore().store),
        ),
      ),
    );
  });

  it.effect("omits cookies on relay requests even when the caller includes them", () => {
    const sentCredentials: Array<RequestCredentials | undefined> = [];
    const fetchFn = ((_input, init) => {
      sentCredentials.push(init?.credentials);
      return Promise.resolve(new Response("Unavailable", { status: 503 }));
    }) satisfies typeof globalThis.fetch;
    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      yield* relayClient
        .listEnvironments({ credential: credential("user-1") })
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }),
          Effect.flip,
        );
      expect(sentCredentials).toEqual(["omit"]);
    }).pipe(Effect.provide(layerManagedRelayTest(fetchFn)));
  });

  it.effect("suggests checking network filtering when fetch fails without a response", () => {
    const fetchFn = (() =>
      Promise.reject(new TypeError("Failed to fetch"))) satisfies typeof globalThis.fetch;
    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const error = yield* relayClient
        .listEnvironments({ credential: credential("user-1") })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ManagedRelayRequestFailedError",
        transportFailed: true,
        message: `Could not list relay-managed environments. ${NETWORK_BLOCKING_HINT}`,
      });
      const encoded = yield* encodeRelayError(error);
      const decoded = yield* decodeRelayError(encoded);
      expect(decoded.message).toBe(error.message);
    }).pipe(
      Effect.provide(layerManagedRelayTest(fetchFn, undefined, seededAccountTokenStore().store)),
    );
  });

  it.effect("does not suggest network filtering for an HTTP server error", () => {
    const fetchFn = (() =>
      Promise.resolve(
        new Response("Unavailable", { status: 503 }),
      )) satisfies typeof globalThis.fetch;
    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const error = yield* relayClient
        .listEnvironments({ credential: credential("user-1") })
        .pipe(Effect.flip);
      expect(error.message).toBe("Could not list relay-managed environments.");
    }).pipe(
      Effect.provide(layerManagedRelayTest(fetchFn, undefined, seededAccountTokenStore().store)),
    );
  });

  it.effect("preserves typed relay trace IDs on client errors", () => {
    const fetchFn = (() =>
      Promise.resolve(
        Response.json(
          {
            _tag: "RelayAuthInvalidError",
            code: "auth_invalid",
            reason: "invalid_bearer",
            traceId: "trace-managed-relay",
          },
          { status: 401 },
        ),
      )) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const error = yield* relayClient
        .listEnvironments({ credential: credential("user-1") })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "ManagedRelayRequestFailedError",
        traceId: "trace-managed-relay",
      });
    }).pipe(
      Effect.provide(layerManagedRelayTest(fetchFn, undefined, seededAccountTokenStore().store)),
    );
  });

  it.effect("accepts generic DPoP errors from relays without the optional reason", () => {
    const fetchFn = (() =>
      Promise.resolve(
        Response.json(
          {
            _tag: "RelayAuthInvalidError",
            code: "auth_invalid",
            reason: "invalid_dpop",
            traceId: "trace-old-relay",
          },
          { status: 401 },
        ),
      )) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const error = yield* relayClient
        .listEnvironments({ credential: credential("user-1") })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "ManagedRelayRequestFailedError",
        traceId: "trace-old-relay",
        relayError: {
          _tag: "RelayAuthInvalidError",
          reason: "invalid_dpop",
        },
      });
      if (
        error._tag === "ManagedRelayRequestFailedError" &&
        error.relayError?._tag === "RelayAuthInvalidError"
      ) {
        expect(error.relayError.dpopFailureReason).toBeUndefined();
      }
    }).pipe(
      Effect.provide(layerManagedRelayTest(fetchFn, undefined, seededAccountTokenStore().store)),
    );
  });

  it.effect("lists account devices through the v2 endpoint with a DPoP account token", () => {
    const fetchFn = ((input, init) => {
      expect(String(input)).toBe("https://relay.example.test/v2/client/devices");
      expect(init?.headers).toMatchObject({
        authorization: "DPoP seeded-account-token",
        dpop: "proof:https://relay.example.test/v2/client/devices",
      });
      return Promise.resolve(
        Response.json({
          devices: [
            {
              deviceId: "device-1",
              label: "Julius's iPhone",
              platform: "ios",
              iosMajorVersion: 18,
              appVersion: "1.0.0",
              notifications: {
                enabled: false,
                notifyOnApproval: true,
                notifyOnInput: true,
                notifyOnCompletion: true,
                notifyOnFailure: true,
              },
              liveActivities: {
                enabled: true,
              },
              updatedAt: "2026-06-01T00:00:00.000Z",
            },
            {
              deviceId: "device-2",
              label: "Android phone",
              platform: "android",
              iosMajorVersion: null,
              androidApiLevel: 36,
              appVersion: "1.0.0",
              notifications: {
                enabled: true,
                notifyOnApproval: true,
                notifyOnInput: true,
                notifyOnCompletion: true,
                notifyOnFailure: true,
              },
              liveActivities: { enabled: true },
              updatedAt: "2026-06-01T00:00:00.000Z",
            },
          ],
        }),
      );
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const devices = yield* relayClient.listDevices({ credential: credential("user-1") });
      expect(devices).toMatchObject([
        {
          deviceId: "device-1",
          label: "Julius's iPhone",
          notifications: {
            enabled: false,
          },
        },
        {
          deviceId: "device-2",
          platform: "android",
          iosMajorVersion: null,
          androidApiLevel: 36,
        },
      ]);
    }).pipe(
      Effect.provide(layerManagedRelayTest(fetchFn, undefined, seededAccountTokenStore().store)),
    );
  });

  it.effect("refreshes one access token for all of the client's scopes", () => {
    const refreshBodies: Array<unknown> = [];
    const authorizations: Array<string | null> = [];
    const fetchFn = ((input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/token")) {
        refreshBodies.push(JSON.parse(String(init?.body)));
        expect(new Headers(init?.headers).get("dpop")).toBe(
          "proof:https://relay.example.test/v1/auth/token",
        );
        return Promise.resolve(
          accessTokenResponse(
            "session-token",
            "environment:connect environment:status mobile:registration account",
          ),
        );
      }
      authorizations.push(new Headers(init?.headers).get("authorization"));
      if (url.endsWith("/v1/environments")) {
        return Promise.resolve(Response.json({ environments: [] }));
      }
      return Promise.resolve(Response.json({ ok: true }));
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      yield* relayClient.listEnvironments({ credential: credential("user-1") });
      yield* relayClient.unregisterDevice({ credential: credential("user-1"), deviceId: "phone" });

      expect(refreshBodies).toEqual([{ refresh_token: "styal_rt_user-1" }]);
      expect(authorizations).toEqual(["DPoP session-token", "DPoP session-token"]);
    }).pipe(Effect.provide(layerManagedRelayTest(fetchFn)));
  });

  it.effect("reports an ended session and forgets its tokens", () => {
    const ended: Array<string> = [];
    const seeded = seededAccountTokenStore();
    const fetchFn = (() =>
      Promise.resolve(
        Response.json(
          {
            _tag: "RelayAuthInvalidError",
            code: "auth_invalid",
            reason: "invalid_session",
            traceId: "trace-ended",
          },
          { status: 401 },
        ),
      )) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const error = yield* relayClient
        .unregisterDevice({ credential: credential("user-1"), deviceId: "phone" })
        .pipe(Effect.flip);

      expect(ManagedRelay.isManagedRelaySessionEnded(error)).toBe(true);
      expect(ended).toEqual(["user-1"]);
      expect(seeded.entries()).toEqual([]);
    }).pipe(
      Effect.provide(
        layerManagedRelayTest(fetchFn, undefined, seeded.store, (ended_) =>
          Effect.sync(() => {
            ended.push(ended_.accountId);
          }),
        ),
      ),
    );
  });

  it.effect("signs out when a request with a cached token learns its session ended", () => {
    const ended: Array<string> = [];
    const requested: Array<string> = [];
    const seeded = seededAccountTokenStore();
    const fetchFn = ((input) => {
      requested.push(String(input));
      return Promise.resolve(
        Response.json(
          {
            _tag: "RelayAuthInvalidError",
            code: "auth_invalid",
            reason: "invalid_session",
            traceId: "trace-revoked",
          },
          { status: 401 },
        ),
      );
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const error = yield* relayClient
        .listDevices({ credential: credential("user-1") })
        .pipe(Effect.flip);

      expect(ManagedRelay.isManagedRelaySessionEnded(error)).toBe(true);
      expect(requested).toEqual(["https://relay.example.test/v2/client/devices"]);
      expect(ended).toEqual(["user-1"]);
      expect(seeded.entries()).toEqual([]);
    }).pipe(
      Effect.provide(
        layerManagedRelayTest(fetchFn, undefined, seeded.store, (ended_) =>
          Effect.sync(() => {
            ended.push(ended_.accountId);
          }),
        ),
      ),
    );
  });

  it.effect("signs in with a code and uses the returned access token straight away", () => {
    const requests: Array<{ readonly url: string; readonly body: unknown }> = [];
    const fetchFn = ((input, init) => {
      const url = String(input);
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/v1/auth/email/verify")) {
        return Promise.resolve(
          Response.json({
            access_token: "sign-in-token",
            token_type: "DPoP",
            expires_in: 1_800,
            scope: "environment:connect environment:status mobile:registration account",
            user: { id: "usr_new", email: "someone@example.com" },
            refresh_token: "styal_rt_new",
            session_id: "session-1",
          }),
        );
      }
      return Promise.resolve(Response.json({ environments: [] }));
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const signIn = yield* relayClient.verifyEmailSignIn({
        email: "someone@example.com",
        code: "12345678",
        label: "Phone",
      });
      yield* relayClient.listEnvironments({ credential: signIn.credential });

      expect(signIn).toEqual({
        credential: { accountId: "usr_new", refreshToken: "styal_rt_new" },
        email: "someone@example.com",
      });
      expect(requests.map((request) => request.url)).toEqual([
        "https://relay.example.test/v1/auth/email/verify",
        "https://relay.example.test/v1/environments",
      ]);
      expect(requests[0]?.body).toEqual({
        email: "someone@example.com",
        code: "12345678",
        client_id: "t3-mobile",
        label: "Phone",
      });
    }).pipe(Effect.provide(layerManagedRelayTest(fetchFn)));
  });

  it.effect("signing out forgets cached tokens before telling the relay", () => {
    const seeded = seededAccountTokenStore();
    const bodies: Array<unknown> = [];
    const fetchFn = ((input, init) => {
      expect(String(input)).toBe("https://relay.example.test/v1/auth/sign-out");
      expect(seeded.entries()).toEqual([]);
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(Response.json({ ok: true }));
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      yield* relayClient.signOut({ credential: credential("user-1") });
      expect(bodies).toEqual([{ refresh_token: "styal_rt_user-1" }]);
    }).pipe(Effect.provide(layerManagedRelayTest(fetchFn, undefined, seeded.store)));
  });
});
