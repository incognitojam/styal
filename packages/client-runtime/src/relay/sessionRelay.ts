import {
  RelayAccountScope,
  type RelayAccountSessionRecord,
  type RelayAccountUser,
  RelaySessionApi as RelayApi,
  type RelayAuthSessionResponse,
  type RelayClientEnvironmentRecord,
  type RelayClientDeviceRecord,
  RelayConnectEnvironmentEndpoint,
  type RelayDeviceRegistrationRequest,
  RelaySessionDpopAccessTokenScope as RelayDpopAccessTokenScope,
  type RelayEmailSignInStartResponse,
  type RelayEnvironmentConnectRequest,
  type RelayEnvironmentConnectResponse,
  type RelayEnvironmentLinkChallengeRequest,
  type RelayEnvironmentLinkChallengeResponse,
  type RelayEnvironmentLinkRequest,
  type RelayEnvironmentLinkResponse,
  type RelayEnvironmentStatusResponse,
  RelayGetEnvironmentStatusEndpoint,
  type RelayAgentActivitySnapshotResponse,
  type RelayLiveActivityRegistrationRequest,
  RelayMobileRegistrationScope,
  type RelayOkResponse,
  type RelayPublicClientId,
  type RelayT3ChatLinkRequestResponse,
  type RelayT3ChatLinkResponse,
  RelayRefreshAuthTokenEndpoint,
  RelayRegisterDeviceEndpoint,
  RelayAgentActivitySnapshotEndpoint,
  RelayRegisterLiveActivityEndpoint,
  RelayProtectedError,
  type RelayProtectedError as RelayProtectedErrorType,
  RelaySignOutEndpoint,
  RelayStartEmailSignInEndpoint,
  RelayUnregisterDeviceEndpoint,
  RelayVerifyEmailSignInEndpoint,
} from "@t3tools/contracts/relay";
import { computeDpopAccessTokenHash } from "@t3tools/shared/dpop";
import { parseAllowedOAuthScope } from "@t3tools/shared/oauthScope";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpMethod from "effect/http/HttpMethod";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

export {
  type ManagedRelayDpopProofInput,
  ManagedRelayDpopKeyLoadError,
  ManagedRelayDpopSigner,
  ManagedRelayClientError,
  ManagedRelayRequestFailedError,
  ManagedRelayRequestTimeoutError,
} from "./managedRelay.ts";
import {
  type ManagedRelayDpopProofInput,
  ManagedRelayDpopSigner,
  type ManagedRelayRequestAction,
  type ManagedRelayRequestActivity,
  ManagedRelayRequestTimeoutError,
  ManagedRelayUrlInvalidError,
  ManagedRelayRequestFailedError,
  ManagedRelayAccessTokenScopesUnexpectedError,
  ManagedRelayTokenProofCreationError,
  ManagedRelayRequestProofCreationError,
  type ManagedRelayDpopProofCreationError,
  type ManagedRelayClientError,
} from "./managedRelay.ts";
type RelayHttpRequestError =
  | RelayProtectedErrorType
  | HttpClientError.HttpClientError
  | Schema.SchemaError;
const MANAGED_RELAY_REQUEST_TIMEOUT_MS = 10_000;

/**
 * A styal Link sign-in: the account and its session credential. The
 * credential is bound to this device's DPoP key and does not change while the
 * session lasts, so it can be stored and reused as is.
 */
export interface ManagedRelayCredential {
  readonly accountId: string;
  readonly refreshToken: string;
}

export interface ManagedRelaySignIn {
  readonly credential: ManagedRelayCredential;
  readonly email: string | null;
}

export interface ManagedRelayAccessTokenCacheEntry {
  readonly sessionTokenHash?: string;
  readonly accountId: string;
  readonly clientId: RelayPublicClientId;
  readonly relayUrl: string;
  readonly thumbprint: string;
  readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
  readonly accessToken: string;
  readonly expiresAtMillis: number;
}

export interface ManagedRelayAccessTokenStore {
  readonly load: Effect.Effect<ReadonlyArray<ManagedRelayAccessTokenCacheEntry>>;
  readonly save: (entries: ReadonlyArray<ManagedRelayAccessTokenCacheEntry>) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
}

export interface ManagedRelayAuthorization {
  readonly accessToken: string;
  readonly proof: string;
  readonly thumbprint: string;
}

export interface ManagedRelayClientLayerOptions {
  readonly relayUrl: string;
  readonly clientId: RelayPublicClientId;
  readonly accessTokenStore?: ManagedRelayAccessTokenStore;
  /**
   * Called when the relay reports that a session has ended (signed out
   * elsewhere, expired, or revoked), so the app can drop the stored sign-in.
   */
  readonly onSessionEnded?: (credential: ManagedRelayCredential) => Effect.Effect<void>;
}

type Credentialed = { readonly credential: ManagedRelayCredential };

export class ManagedRelayClient extends Context.Service<
  ManagedRelayClient,
  {
    readonly relayUrl: string;
    readonly startEmailSignIn: (input: {
      readonly email: string;
    }) => Effect.Effect<RelayEmailSignInStartResponse, ManagedRelayClientError>;
    readonly verifyEmailSignIn: (input: {
      readonly email: string;
      readonly code: string;
      readonly label?: string;
    }) => Effect.Effect<ManagedRelaySignIn, ManagedRelayClientError>;
    /** Ends the session at the relay and forgets its cached access tokens. */
    readonly signOut: (input: Credentialed) => Effect.Effect<void, ManagedRelayClientError>;
    readonly getAccount: (
      input: Credentialed,
    ) => Effect.Effect<RelayAccountUser, ManagedRelayClientError>;
    readonly listSessions: (
      input: Credentialed,
    ) => Effect.Effect<ReadonlyArray<RelayAccountSessionRecord>, ManagedRelayClientError>;
    readonly revokeSession: (
      input: Credentialed & { readonly sessionId: string },
    ) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
    /** Deletes the account and everything the relay keeps for it, then forgets its tokens. */
    readonly deleteAccount: (input: Credentialed) => Effect.Effect<void, ManagedRelayClientError>;
    readonly listEnvironments: (
      input: Credentialed,
    ) => Effect.Effect<ReadonlyArray<RelayClientEnvironmentRecord>, ManagedRelayClientError>;
    readonly listDevices: (
      input: Credentialed,
    ) => Effect.Effect<ReadonlyArray<RelayClientDeviceRecord>, ManagedRelayClientError>;
    readonly createEnvironmentLinkChallenge: (
      input: Credentialed & { readonly payload: RelayEnvironmentLinkChallengeRequest },
    ) => Effect.Effect<RelayEnvironmentLinkChallengeResponse, ManagedRelayClientError>;
    readonly linkEnvironment: (
      input: Credentialed & { readonly payload: RelayEnvironmentLinkRequest },
    ) => Effect.Effect<RelayEnvironmentLinkResponse, ManagedRelayClientError>;
    readonly unlinkEnvironment: (
      input: Credentialed & {
        readonly environmentId: RelayClientEnvironmentRecord["environmentId"];
      },
    ) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
    readonly getT3ChatLink: (
      input: Credentialed,
    ) => Effect.Effect<RelayT3ChatLinkResponse, ManagedRelayClientError>;
    readonly createT3ChatLinkRequest: (
      input: Credentialed,
    ) => Effect.Effect<RelayT3ChatLinkRequestResponse, ManagedRelayClientError>;
    readonly unlinkT3Chat: (
      input: Credentialed,
    ) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
    readonly getEnvironmentStatus: (
      input: Credentialed & {
        readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
        readonly environmentId: RelayClientEnvironmentRecord["environmentId"];
      },
    ) => Effect.Effect<RelayEnvironmentStatusResponse, ManagedRelayClientError>;
    readonly connectEnvironment: (
      input: Credentialed & {
        readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
        readonly environmentId: RelayClientEnvironmentRecord["environmentId"];
        readonly deviceId?: string;
      },
    ) => Effect.Effect<RelayEnvironmentConnectResponse, ManagedRelayClientError>;
    readonly registerDevice: (
      input: Credentialed & { readonly payload: RelayDeviceRegistrationRequest },
    ) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
    readonly unregisterDevice: (
      input: Credentialed & { readonly deviceId: string },
    ) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
    readonly registerLiveActivity: (
      input: Credentialed & { readonly payload: RelayLiveActivityRegistrationRequest },
    ) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
    readonly getAgentActivitySnapshot: (
      input: Credentialed,
    ) => Effect.Effect<RelayAgentActivitySnapshotResponse, ManagedRelayClientError>;
    readonly resetTokenCache: Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/relay/sessionRelay/ManagedRelayClient") {}

const isRelayProtectedError = Schema.is(RelayProtectedError);

const TRACEPARENT_TRACE_ID = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i;

function untypedResponseFields(cause: RelayHttpRequestError) {
  const response = HttpClientError.isHttpClientError(cause) ? cause.response : undefined;
  if (!response) return {};
  const traceId = TRACEPARENT_TRACE_ID.exec(response.headers.traceparent ?? "")?.[1];
  return { status: response.status, ...(traceId ? { traceId } : {}) };
}

function relayRequestError(action: ManagedRelayRequestAction) {
  return (cause: RelayHttpRequestError): ManagedRelayClientError =>
    new ManagedRelayRequestFailedError({
      action,
      transportFailed:
        HttpClientError.isHttpClientError(cause) && cause.reason._tag === "TransportError",
      cause,
      ...(isRelayProtectedError(cause)
        ? { relayError: cause, traceId: cause.traceId }
        : untypedResponseFields(cause)),
    });
}

function proofCreationErrorFields(error: ManagedRelayDpopProofCreationError) {
  return {
    method: error.method,
    url: error.url,
    cause: error,
  };
}

function isRejectedDpopAccessToken(error: ManagedRelayClientError): boolean {
  return (
    error._tag === "ManagedRelayRequestFailedError" &&
    error.relayError?._tag === "RelayAuthInvalidError" &&
    error.relayError.reason === "invalid_bearer"
  );
}

/** Whether a relay failure means the sign-in itself has ended, not just one request. */
export function isManagedRelaySessionEnded(error: ManagedRelayClientError): boolean {
  return (
    error._tag === "ManagedRelayRequestFailedError" &&
    error.relayError?._tag === "RelayAuthInvalidError" &&
    error.relayError.reason === "invalid_session"
  );
}

function timeoutRelayRequest(activity: ManagedRelayRequestActivity) {
  return <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ManagedRelayClientError, R> =>
    effect.pipe(
      Effect.timeoutOption(Duration.millis(MANAGED_RELAY_REQUEST_TIMEOUT_MS)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.currentParentSpan.pipe(
              Effect.map((span) => span.traceId),
              Effect.orElseSucceed(() => null),
              Effect.flatMap((traceId) =>
                Effect.fail(
                  new ManagedRelayRequestTimeoutError({
                    activity,
                    timeoutMs: MANAGED_RELAY_REQUEST_TIMEOUT_MS,
                    traceId,
                  }),
                ),
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
}

function tokenMatches(
  token: ManagedRelayAccessTokenCacheEntry,
  input: {
    readonly accountId: string;
    readonly clientId: RelayPublicClientId;
    readonly relayUrl: string;
    readonly thumbprint: string;
    readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
    readonly sessionTokenHash: string;
    readonly nowMillis: number;
  },
): boolean {
  return (
    token.accountId === input.accountId &&
    token.sessionTokenHash === input.sessionTokenHash &&
    token.clientId === input.clientId &&
    token.relayUrl === input.relayUrl &&
    token.thumbprint === input.thumbprint &&
    token.expiresAtMillis > input.nowMillis + 5_000 &&
    input.scopes.every((scope) => token.scopes.includes(scope))
  );
}

const ALL_RELAY_SCOPES: ReadonlySet<RelayDpopAccessTokenScope> = new Set(
  RelayDpopAccessTokenScope.literals,
);

function grantedScopes(scope: string): ReadonlyArray<RelayDpopAccessTokenScope> {
  return parseAllowedOAuthScope({ value: scope, allowedScopes: ALL_RELAY_SCOPES }) ?? [];
}

function dpopHeaders(authorization: ManagedRelayAuthorization) {
  return {
    authorization: `DPoP ${authorization.accessToken}`,
    dpop: authorization.proof,
  };
}

function disabledManagedRelayClient(relayUrl: string): ManagedRelayClient["Service"] {
  const unavailable = (spanName: string) =>
    Effect.fn(spanName)(function* () {
      return yield* new ManagedRelayUrlInvalidError({ relayUrl });
    });
  return ManagedRelayClient.of({
    relayUrl,
    startEmailSignIn: unavailable("clientRuntime.managedRelay.startEmailSignIn"),
    verifyEmailSignIn: unavailable("clientRuntime.managedRelay.verifyEmailSignIn"),
    signOut: unavailable("clientRuntime.managedRelay.signOut"),
    getAccount: unavailable("clientRuntime.managedRelay.getAccount"),
    listSessions: unavailable("clientRuntime.managedRelay.listSessions"),
    revokeSession: unavailable("clientRuntime.managedRelay.revokeSession"),
    deleteAccount: unavailable("clientRuntime.managedRelay.deleteAccount"),
    listEnvironments: unavailable("clientRuntime.managedRelay.listEnvironments"),
    listDevices: unavailable("clientRuntime.managedRelay.listDevices"),
    createEnvironmentLinkChallenge: unavailable(
      "clientRuntime.managedRelay.createEnvironmentLinkChallenge",
    ),
    linkEnvironment: unavailable("clientRuntime.managedRelay.linkEnvironment"),
    unlinkEnvironment: unavailable("clientRuntime.managedRelay.unlinkEnvironment"),
    getT3ChatLink: unavailable("clientRuntime.managedRelay.getT3ChatLink"),
    createT3ChatLinkRequest: unavailable("clientRuntime.managedRelay.createT3ChatLinkRequest"),
    unlinkT3Chat: unavailable("clientRuntime.managedRelay.unlinkT3Chat"),
    getEnvironmentStatus: unavailable("clientRuntime.managedRelay.getEnvironmentStatus"),
    connectEnvironment: unavailable("clientRuntime.managedRelay.connectEnvironment"),
    registerDevice: unavailable("clientRuntime.managedRelay.registerDevice"),
    unregisterDevice: unavailable("clientRuntime.managedRelay.unregisterDevice"),
    registerLiveActivity: unavailable("clientRuntime.managedRelay.registerLiveActivity"),
    getAgentActivitySnapshot: unavailable("clientRuntime.managedRelay.getAgentActivitySnapshot"),
    resetTokenCache: Effect.void.pipe(
      Effect.withSpan("clientRuntime.managedRelay.resetTokenCache"),
    ),
  });
}

/** @public */
export const make = Effect.fn("ManagedRelayClient.make")(function* (
  options: ManagedRelayClientLayerOptions,
) {
  const relayUrl = normalizeSecureRelayUrl(options.relayUrl);
  if (relayUrl === null) {
    return disabledManagedRelayClient(options.relayUrl);
  }
  const signer = yield* ManagedRelayDpopSigner;
  const client = yield* HttpApiClient.make(RelayApi, {
    baseUrl: relayUrl,
    // Relay requests authenticate with headers, never cookies. A caller's
    // `credentials: "include"` (the same-origin primary environment layer)
    // would make browsers reject the relay's wildcard CORS responses.
    transformClient: HttpClient.transform((request) =>
      Effect.provideService(request, FetchHttpClient.RequestInit, { credentials: "omit" }),
    ),
  });
  const initialTokens = options.accessTokenStore ? yield* options.accessTokenStore.load : [];
  const cachedTokens = yield* SynchronizedRef.make<
    ReadonlyArray<ManagedRelayAccessTokenCacheEntry>
  >(
    initialTokens.filter(
      (token) => token.clientId === options.clientId && token.sessionTokenHash !== undefined,
    ),
  );
  const urlBuilder = HttpApiClient.urlBuilder(RelayApi, { baseUrl: relayUrl });

  type DpopProofTarget = Pick<ManagedRelayDpopProofInput, "method" | "url">;
  const target = (method: HttpMethod.HttpMethod, url: string): DpopProofTarget => ({
    method,
    url,
  });
  const dpopProofTargets = {
    startEmailSignIn: () =>
      target(RelayStartEmailSignInEndpoint.method, urlBuilder.auth.startEmailSignIn()),
    verifyEmailSignIn: () =>
      target(RelayVerifyEmailSignInEndpoint.method, urlBuilder.auth.verifyEmailSignIn()),
    refreshAuthToken: () =>
      target(RelayRefreshAuthTokenEndpoint.method, urlBuilder.auth.refreshAuthToken()),
    signOut: () => target(RelaySignOutEndpoint.method, urlBuilder.auth.signOut()),
    listEnvironments: () => target("GET", urlBuilder.client.listEnvironments()),
    listDevices: () => target("GET", urlBuilder.client.listDevicesV2()),
    createEnvironmentLinkChallenge: () =>
      target("POST", urlBuilder.client.createEnvironmentLinkChallenge()),
    linkEnvironment: () => target("POST", urlBuilder.client.linkEnvironment()),
    unlinkEnvironment: (environmentId: RelayClientEnvironmentRecord["environmentId"]) =>
      target("DELETE", urlBuilder.client.unlinkEnvironment({ params: { environmentId } })),
    getAccount: () => target("GET", urlBuilder.client.getAccount()),
    listSessions: () => target("GET", urlBuilder.client.listAccountSessions()),
    deleteAccount: () => target("DELETE", urlBuilder.client.deleteAccount()),
    getT3ChatLink: () => target("GET", urlBuilder.client.getT3ChatLink()),
    createT3ChatLinkRequest: () => target("POST", urlBuilder.client.createT3ChatLinkRequest()),
    unlinkT3Chat: () => target("DELETE", urlBuilder.client.unlinkT3Chat()),
    revokeSession: (sessionId: string) =>
      target("DELETE", urlBuilder.client.revokeAccountSession({ params: { sessionId } })),
    getEnvironmentStatus: (environmentId: RelayClientEnvironmentRecord["environmentId"]) =>
      target(
        RelayGetEnvironmentStatusEndpoint.method,
        urlBuilder.dpopClient.getEnvironmentStatus({ params: { environmentId } }),
      ),
    connectEnvironment: (environmentId: RelayClientEnvironmentRecord["environmentId"]) =>
      target(
        RelayConnectEnvironmentEndpoint.method,
        urlBuilder.dpopClient.connectEnvironment({ params: { environmentId } }),
      ),
    registerDevice: () =>
      target(RelayRegisterDeviceEndpoint.method, urlBuilder.mobile.registerDevice()),
    unregisterDevice: (deviceId: string) =>
      target(
        RelayUnregisterDeviceEndpoint.method,
        urlBuilder.mobile.unregisterDevice({ params: { deviceId } }),
      ),
    getAgentActivitySnapshot: () =>
      target(
        RelayAgentActivitySnapshotEndpoint.method,
        urlBuilder.mobile.getAgentActivitySnapshot(),
      ),
    registerLiveActivity: () =>
      target(RelayRegisterLiveActivityEndpoint.method, urlBuilder.mobile.registerLiveActivity()),
  };

  // A proof for an auth endpoint, which takes no access token.
  const authProof = (proofTarget: DpopProofTarget) =>
    signer
      .createProof(proofTarget)
      .pipe(
        Effect.mapError(
          (error) => new ManagedRelayTokenProofCreationError(proofCreationErrorFields(error)),
        ),
      );

  const cacheEntry = Effect.fnUntraced(function* (input: {
    readonly accountId: string;
    readonly thumbprint: string;
    readonly accessToken: string;
    readonly scope: string;
    readonly expiresIn: number;
    readonly sessionTokenHash: string;
  }) {
    const nowMillis = yield* Clock.currentTimeMillis;
    return {
      accountId: input.accountId,
      sessionTokenHash: input.sessionTokenHash,
      clientId: options.clientId,
      relayUrl,
      thumbprint: input.thumbprint,
      scopes: grantedScopes(input.scope),
      accessToken: input.accessToken,
      expiresAtMillis: nowMillis + input.expiresIn * 1_000,
    } satisfies ManagedRelayAccessTokenCacheEntry;
  });

  const storeTokens = (tokens: ReadonlyArray<ManagedRelayAccessTokenCacheEntry>) =>
    options.accessTokenStore ? options.accessTokenStore.save(tokens) : Effect.void;

  const forgetCredential = (credential: ManagedRelayCredential) =>
    SynchronizedRef.updateEffect(cachedTokens, (tokens) => {
      const nextTokens = tokens.filter(
        (token) => token.sessionTokenHash !== computeDpopAccessTokenHash(credential.refreshToken),
      );
      return storeTokens(nextTokens).pipe(Effect.as(nextTokens));
    });

  // The session's own handler compares credentials, so a late failure from an
  // ended session cannot clear a newer sign-in.
  const endSessionOn = (credential: ManagedRelayCredential) => (error: ManagedRelayClientError) =>
    isManagedRelaySessionEnded(error)
      ? forgetCredential(credential).pipe(
          Effect.andThen(options.onSessionEnded?.(credential) ?? Effect.void),
        )
      : Effect.void;

  const refreshAccessToken = Effect.fn("clientRuntime.managedRelay.refreshAccessToken")(function* (
    credential: ManagedRelayCredential,
  ) {
    yield* Effect.annotateCurrentSpan({ "relay.client_id": options.clientId });
    const proof = yield* authProof(dpopProofTargets.refreshAuthToken());
    return yield* client.auth
      .refreshAuthToken({
        headers: { dpop: proof },
        payload: { refresh_token: credential.refreshToken },
      })
      .pipe(
        Effect.mapError(relayRequestError("refresh relay access token")),
        timeoutRelayRequest("Relay access token refresh"),
      );
  });

  const obtainAccessToken = Effect.fn("clientRuntime.managedRelay.obtainAccessToken")(
    function* (input: {
      readonly credential: ManagedRelayCredential;
      readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
      readonly thumbprint: string;
    }) {
      yield* Effect.annotateCurrentSpan({
        "relay.client_id": options.clientId,
        "relay.scopes": input.scopes.join(" "),
      });
      const nowMillis = yield* Clock.currentTimeMillis;
      const match = {
        accountId: input.credential.accountId,
        sessionTokenHash: computeDpopAccessTokenHash(input.credential.refreshToken),
        clientId: options.clientId,
        relayUrl,
        thumbprint: input.thumbprint,
        scopes: input.scopes,
        nowMillis,
      };
      // Cache hits do not need to wait for an unrelated refresh or store write.
      const cached = (yield* SynchronizedRef.get(cachedTokens)).find((token) =>
        tokenMatches(token, match),
      );
      if (cached) {
        yield* Effect.annotateCurrentSpan({ "relay.token_cache.result": "hit" });
        return cached;
      }
      return yield* SynchronizedRef.modifyEffect(cachedTokens, (tokens) =>
        Effect.gen(function* () {
          const lookupMillis = yield* Clock.currentTimeMillis;
          const activeTokens = tokens.filter(
            (token) => token.expiresAtMillis > lookupMillis + 5_000,
          );
          const cached = activeTokens.find((token) =>
            tokenMatches(token, { ...match, nowMillis: lookupMillis }),
          );
          if (cached) {
            yield* Effect.annotateCurrentSpan({ "relay.token_cache.result": "hit" });
            return [cached, activeTokens] as const;
          }
          yield* Effect.annotateCurrentSpan({ "relay.token_cache.result": "miss" });
          const response = yield* refreshAccessToken(input.credential);
          const next = yield* cacheEntry({
            accountId: input.credential.accountId,
            sessionTokenHash: match.sessionTokenHash,
            thumbprint: input.thumbprint,
            accessToken: response.access_token,
            scope: response.scope,
            expiresIn: response.expires_in,
          });
          if (!input.scopes.every((scope) => next.scopes.includes(scope))) {
            return yield* new ManagedRelayAccessTokenScopesUnexpectedError({
              requestedScopes: input.scopes,
              grantedScope: response.scope,
            });
          }
          const nextTokens = [
            ...activeTokens.filter((token) => token.sessionTokenHash !== next.sessionTokenHash),
            next,
          ];
          yield* storeTokens(nextTokens);
          return [next, nextTokens] as const;
        }),
      ).pipe(
        Effect.withSpan("clientRuntime.managedRelay.tokenCacheCriticalSection"),
        // Outside the critical section: forgetting the account takes the same lock.
        Effect.tapError(endSessionOn(input.credential)),
      );
    },
  );

  const authorize = Effect.fn("clientRuntime.managedRelay.authorize")(function* (input: {
    readonly credential: ManagedRelayCredential;
    readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
    readonly target: DpopProofTarget;
  }) {
    yield* Effect.annotateCurrentSpan({
      "relay.client_id": options.clientId,
      "relay.scopes": input.scopes.join(" "),
      "http.request.method": input.target.method,
      "url.full": input.target.url,
    });
    const thumbprint = yield* signer.thumbprint;
    const token = yield* obtainAccessToken({
      credential: input.credential,
      scopes: input.scopes,
      thumbprint,
    });
    const proof = yield* signer
      .createProof({
        ...input.target,
        accessToken: token.accessToken,
      })
      .pipe(
        Effect.mapError(
          (error) => new ManagedRelayRequestProofCreationError(proofCreationErrorFields(error)),
        ),
      );
    return { accessToken: token.accessToken, proof, thumbprint };
  });

  const invalidateAccessToken = Effect.fn("clientRuntime.managedRelay.invalidateAccessToken")(
    function* (accessToken: string) {
      return yield* SynchronizedRef.modifyEffect(cachedTokens, (tokens) => {
        const nextTokens = tokens.filter((token) => token.accessToken !== accessToken);
        if (nextTokens.length === tokens.length) {
          return Effect.succeed([false, tokens] as const);
        }
        return storeTokens(nextTokens).pipe(Effect.as([true, nextTokens] as const));
      });
    },
  );

  const runDpopRequest = <A>(
    input: {
      readonly credential: ManagedRelayCredential;
      readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
      readonly target: DpopProofTarget;
    },
    request: (
      authorization: ManagedRelayAuthorization,
    ) => Effect.Effect<A, ManagedRelayClientError>,
  ): Effect.Effect<A, ManagedRelayClientError> => {
    const attempt = (refreshRejectedToken: boolean): Effect.Effect<A, ManagedRelayClientError> =>
      authorize(input).pipe(
        Effect.flatMap((authorization) =>
          request(authorization).pipe(
            // The relay ends access tokens with their session, so any request can learn of it.
            Effect.tapError(endSessionOn(input.credential)),
            Effect.catchIf(isRejectedDpopAccessToken, (error) =>
              invalidateAccessToken(authorization.accessToken).pipe(
                Effect.tap((invalidated) =>
                  Effect.annotateCurrentSpan({
                    "relay.token_cache.invalidated": invalidated,
                    "relay.token_cache.invalidation_reason": "invalid_bearer",
                    "relay.token_cache.retry_after_invalidation": refreshRejectedToken,
                  }),
                ),
                Effect.tap((invalidated) =>
                  invalidated && refreshRejectedToken
                    ? Effect.logWarning(
                        "Relay rejected a cached DPoP access token; refreshing it once.",
                      )
                    : Effect.void,
                ),
                Effect.andThen(refreshRejectedToken ? attempt(false) : Effect.fail(error)),
              ),
            ),
          ),
        ),
      );
    return attempt(true);
  };

  const accountRequest = <A>(
    input: Credentialed & { readonly target: DpopProofTarget },
    request: (
      authorization: ManagedRelayAuthorization,
    ) => Effect.Effect<A, ManagedRelayClientError>,
  ) => runDpopRequest({ ...input, scopes: [RelayAccountScope] }, request);

  const mobileRegistrationRequest = <A>(
    input: Credentialed & { readonly target: DpopProofTarget },
    request: (
      authorization: ManagedRelayAuthorization,
    ) => Effect.Effect<A, ManagedRelayClientError>,
  ) => runDpopRequest({ ...input, scopes: [RelayMobileRegistrationScope] }, request);

  // Signing in also returns an access token; cache it so the first request
  // after sign-in does not refresh.
  const acceptSession = Effect.fnUntraced(function* (response: RelayAuthSessionResponse) {
    const thumbprint = yield* signer.thumbprint;
    const entry = yield* cacheEntry({
      accountId: response.user.id,
      sessionTokenHash: computeDpopAccessTokenHash(response.refresh_token),
      thumbprint,
      accessToken: response.access_token,
      scope: response.scope,
      expiresIn: response.expires_in,
    });
    yield* SynchronizedRef.updateEffect(cachedTokens, (tokens) => {
      const nextTokens = [...tokens.filter((token) => token.accountId !== entry.accountId), entry];
      return storeTokens(nextTokens).pipe(Effect.as(nextTokens));
    });
    return {
      credential: { accountId: response.user.id, refreshToken: response.refresh_token },
      email: response.user.email,
    } satisfies ManagedRelaySignIn;
  });

  return ManagedRelayClient.of({
    relayUrl,
    startEmailSignIn: Effect.fnUntraced(
      function* (input) {
        const proof = yield* authProof(dpopProofTargets.startEmailSignIn());
        return yield* client.auth
          .startEmailSignIn({
            headers: { dpop: proof },
            payload: { email: input.email, client_id: options.clientId },
          })
          .pipe(
            Effect.mapError(relayRequestError("send styal Link sign-in code")),
            timeoutRelayRequest("styal Link sign-in code request"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelay.startEmailSignIn"),
      withRelayClientTracing,
    ),
    verifyEmailSignIn: Effect.fnUntraced(
      function* (input) {
        const proof = yield* authProof(dpopProofTargets.verifyEmailSignIn());
        const response = yield* client.auth
          .verifyEmailSignIn({
            headers: { dpop: proof },
            payload: {
              email: input.email,
              code: input.code,
              client_id: options.clientId,
              ...(input.label ? { label: input.label } : {}),
            },
          })
          .pipe(
            Effect.mapError(relayRequestError("verify styal Link sign-in code")),
            timeoutRelayRequest("styal Link sign-in code verification"),
          );
        return yield* acceptSession(response);
      },
      Effect.withSpan("clientRuntime.managedRelay.verifyEmailSignIn"),
      withRelayClientTracing,
    ),
    signOut: Effect.fnUntraced(
      function* (input) {
        yield* forgetCredential(input.credential);
        const proof = yield* authProof(dpopProofTargets.signOut());
        yield* client.auth
          .signOut({
            headers: { dpop: proof },
            payload: { refresh_token: input.credential.refreshToken },
          })
          .pipe(
            Effect.mapError(relayRequestError("sign out of styal Link")),
            timeoutRelayRequest("styal Link sign-out"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelay.signOut"),
      withRelayClientTracing,
    ),
    getAccount: Effect.fnUntraced(
      function* (input) {
        return yield* accountRequest(
          { credential: input.credential, target: dpopProofTargets.getAccount() },
          (authorization) =>
            client.client.getAccount({ headers: dpopHeaders(authorization) }).pipe(
              Effect.map((response) => response.user),
              Effect.mapError(relayRequestError("read styal Link account")),
              timeoutRelayRequest("styal Link account request"),
            ),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.getAccount"),
      withRelayClientTracing,
    ),
    listSessions: Effect.fnUntraced(
      function* (input) {
        return yield* accountRequest(
          { credential: input.credential, target: dpopProofTargets.listSessions() },
          (authorization) =>
            client.client.listAccountSessions({ headers: dpopHeaders(authorization) }).pipe(
              Effect.map((response) => response.sessions),
              Effect.mapError(relayRequestError("list styal Link sessions")),
              timeoutRelayRequest("styal Link session listing"),
            ),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.listSessions"),
      withRelayClientTracing,
    ),
    revokeSession: Effect.fnUntraced(
      function* (input) {
        return yield* accountRequest(
          { credential: input.credential, target: dpopProofTargets.revokeSession(input.sessionId) },
          (authorization) =>
            client.client
              .revokeAccountSession({
                headers: dpopHeaders(authorization),
                params: { sessionId: input.sessionId },
              })
              .pipe(
                Effect.mapError(relayRequestError("sign out a styal Link session")),
                timeoutRelayRequest("styal Link session sign-out"),
              ),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.revokeSession"),
      withRelayClientTracing,
    ),
    deleteAccount: Effect.fnUntraced(
      function* (input) {
        yield* accountRequest(
          { credential: input.credential, target: dpopProofTargets.deleteAccount() },
          (authorization) =>
            client.client
              .deleteAccount({ headers: dpopHeaders(authorization) })
              .pipe(
                Effect.mapError(relayRequestError("delete styal Link account")),
                timeoutRelayRequest("styal Link account deletion"),
              ),
        );
        yield* forgetCredential(input.credential);
      },
      Effect.withSpan("clientRuntime.managedRelay.deleteAccount"),
      withRelayClientTracing,
    ),
    listEnvironments: Effect.fnUntraced(
      function* (input) {
        return yield* accountRequest(
          { credential: input.credential, target: dpopProofTargets.listEnvironments() },
          (authorization) =>
            client.client.listEnvironments({ headers: dpopHeaders(authorization) }).pipe(
              Effect.map((response) => response.environments),
              Effect.mapError(relayRequestError("list relay-managed environments")),
              timeoutRelayRequest("Relay environment listing"),
            ),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.listEnvironments"),
      withRelayClientTracing,
    ),
    listDevices: Effect.fnUntraced(
      function* (input) {
        return yield* accountRequest(
          { credential: input.credential, target: dpopProofTargets.listDevices() },
          (authorization) =>
            client.client.listDevicesV2({ headers: dpopHeaders(authorization) }).pipe(
              Effect.map((response) => response.devices),
              Effect.mapError(relayRequestError("list relay client devices")),
              timeoutRelayRequest("Relay client device listing"),
            ),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.listDevices"),
      withRelayClientTracing,
    ),
    createEnvironmentLinkChallenge: Effect.fnUntraced(
      function* (input) {
        return yield* accountRequest(
          {
            credential: input.credential,
            target: dpopProofTargets.createEnvironmentLinkChallenge(),
          },
          (authorization) =>
            client.client
              .createEnvironmentLinkChallenge({
                headers: dpopHeaders(authorization),
                payload: input.payload,
              })
              .pipe(
                Effect.mapError(relayRequestError("create relay environment link challenge")),
                timeoutRelayRequest("Relay environment link challenge"),
              ),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.createEnvironmentLinkChallenge"),
      withRelayClientTracing,
    ),
    linkEnvironment: Effect.fnUntraced(
      function* (input) {
        return yield* accountRequest(
          { credential: input.credential, target: dpopProofTargets.linkEnvironment() },
          (authorization) =>
            client.client
              .linkEnvironment({
                headers: dpopHeaders(authorization),
                payload: input.payload,
              })
              .pipe(
                Effect.mapError(relayRequestError("link relay environment")),
                timeoutRelayRequest("Relay environment linking"),
              ),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.linkEnvironment"),
      withRelayClientTracing,
    ),
    unlinkEnvironment: Effect.fnUntraced(
      function* (input) {
        return yield* accountRequest(
          {
            credential: input.credential,
            target: dpopProofTargets.unlinkEnvironment(input.environmentId),
          },
          (authorization) =>
            client.client
              .unlinkEnvironment({
                headers: dpopHeaders(authorization),
                params: { environmentId: input.environmentId },
              })
              .pipe(
                Effect.mapError(relayRequestError("unlink relay environment")),
                timeoutRelayRequest("Relay environment unlinking"),
              ),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.unlinkEnvironment"),
      withRelayClientTracing,
    ),
    getT3ChatLink: Effect.fnUntraced(
      function* (input) {
        return yield* accountRequest(
          { credential: input.credential, target: dpopProofTargets.getT3ChatLink() },
          (authorization) =>
            client.client
              .getT3ChatLink({ headers: dpopHeaders(authorization) })
              .pipe(
                Effect.mapError(relayRequestError("read linked T3 Chat account")),
                timeoutRelayRequest("Relay T3 Chat link lookup"),
              ),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.getT3ChatLink"),
      withRelayClientTracing,
    ),
    createT3ChatLinkRequest: Effect.fnUntraced(
      function* (input) {
        return yield* accountRequest(
          { credential: input.credential, target: dpopProofTargets.createT3ChatLinkRequest() },
          (authorization) =>
            client.client
              .createT3ChatLinkRequest({ headers: dpopHeaders(authorization) })
              .pipe(
                Effect.mapError(relayRequestError("start T3 Chat linking")),
                timeoutRelayRequest("Relay T3 Chat link request"),
              ),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.createT3ChatLinkRequest"),
      withRelayClientTracing,
    ),
    unlinkT3Chat: Effect.fnUntraced(
      function* (input) {
        return yield* accountRequest(
          { credential: input.credential, target: dpopProofTargets.unlinkT3Chat() },
          (authorization) =>
            client.client
              .unlinkT3Chat({ headers: dpopHeaders(authorization) })
              .pipe(
                Effect.mapError(relayRequestError("unlink T3 Chat account")),
                timeoutRelayRequest("Relay T3 Chat unlinking"),
              ),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.unlinkT3Chat"),
      withRelayClientTracing,
    ),
    getEnvironmentStatus: Effect.fnUntraced(
      function* (input) {
        yield* Effect.annotateCurrentSpan({
          "environment.id": input.environmentId,
        });
        return yield* runDpopRequest(
          {
            credential: input.credential,
            scopes: input.scopes,
            target: dpopProofTargets.getEnvironmentStatus(input.environmentId),
          },
          (authorization) =>
            client.dpopClient
              .getEnvironmentStatus({
                headers: dpopHeaders(authorization),
                params: { environmentId: input.environmentId },
              })
              .pipe(
                Effect.mapError(relayRequestError("get relay environment status")),
                timeoutRelayRequest("Relay environment status request"),
              ),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.getEnvironmentStatus"),
      withRelayClientTracing,
    ),
    connectEnvironment: Effect.fnUntraced(
      function* (input) {
        yield* Effect.annotateCurrentSpan({
          "environment.id": input.environmentId,
        });
        return yield* runDpopRequest(
          {
            credential: input.credential,
            scopes: input.scopes,
            target: dpopProofTargets.connectEnvironment(input.environmentId),
          },
          (authorization) => {
            const payload: RelayEnvironmentConnectRequest = {
              ...(input.deviceId ? { deviceId: input.deviceId } : {}),
              clientKeyThumbprint: authorization.thumbprint,
            };
            return client.dpopClient
              .connectEnvironment({
                headers: dpopHeaders(authorization),
                params: { environmentId: input.environmentId },
                payload,
              })
              .pipe(
                Effect.mapError(relayRequestError("connect relay environment")),
                timeoutRelayRequest("Relay environment connection"),
              );
          },
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.connectEnvironment"),
      withRelayClientTracing,
    ),
    registerDevice: Effect.fnUntraced(
      function* (input) {
        return yield* mobileRegistrationRequest(
          { credential: input.credential, target: dpopProofTargets.registerDevice() },
          (authorization) =>
            client.mobile
              .registerDevice({
                headers: dpopHeaders(authorization),
                payload: input.payload,
              })
              .pipe(
                Effect.mapError(relayRequestError("register relay mobile device")),
                timeoutRelayRequest("Relay mobile device registration"),
              ),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.registerDevice"),
      withRelayClientTracing,
    ),
    unregisterDevice: Effect.fnUntraced(
      function* (input) {
        return yield* mobileRegistrationRequest(
          {
            credential: input.credential,
            target: dpopProofTargets.unregisterDevice(input.deviceId),
          },
          (authorization) =>
            client.mobile
              .unregisterDevice({
                headers: dpopHeaders(authorization),
                params: { deviceId: input.deviceId },
              })
              .pipe(
                Effect.mapError(relayRequestError("unregister relay mobile device")),
                timeoutRelayRequest("Relay mobile device unregistration"),
              ),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.unregisterDevice"),
      withRelayClientTracing,
    ),
    getAgentActivitySnapshot: Effect.fnUntraced(
      function* (input) {
        return yield* mobileRegistrationRequest(
          { credential: input.credential, target: dpopProofTargets.getAgentActivitySnapshot() },
          (authorization) =>
            client.mobile
              .getAgentActivitySnapshot({
                headers: dpopHeaders(authorization),
              })
              .pipe(
                Effect.mapError(relayRequestError("read relay agent activity snapshot")),
                timeoutRelayRequest("Relay agent activity snapshot"),
              ),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.getAgentActivitySnapshot"),
      withRelayClientTracing,
    ),
    registerLiveActivity: Effect.fnUntraced(
      function* (input) {
        return yield* mobileRegistrationRequest(
          { credential: input.credential, target: dpopProofTargets.registerLiveActivity() },
          (authorization) =>
            client.mobile
              .registerLiveActivity({
                headers: dpopHeaders(authorization),
                payload: input.payload,
              })
              .pipe(
                Effect.mapError(relayRequestError("register relay live activity")),
                timeoutRelayRequest("Relay Live Activity registration"),
              ),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.registerLiveActivity"),
      withRelayClientTracing,
    ),
    resetTokenCache: SynchronizedRef.set(cachedTokens, []).pipe(
      Effect.andThen(options.accessTokenStore ? options.accessTokenStore.clear : Effect.void),
      Effect.withSpan("clientRuntime.managedRelay.resetTokenCache"),
      withRelayClientTracing,
    ),
  });
});

export const layer = (options: ManagedRelayClientLayerOptions) =>
  Layer.effect(ManagedRelayClient, make(options));
